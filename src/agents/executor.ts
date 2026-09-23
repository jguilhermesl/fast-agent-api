import OpenAI from 'openai';
import { config } from '../config';
import { getAgentIntents, getIntentLogs, saveTokenUsage, calcCostUsd, buildTokenLogEntry, logError } from '../services/supabase';
import { capTimeout } from '../services/deadline';
import {
  handleExecutarIntent,
  handleAtualizarLeadCRM,
  handleEnviarArquivo,
  handleKnowledgeBase,
} from '../tools/handlers';
import { 
  EXECUTOR_TOOLS, 
  toOpenAITools,
  createDynamicToolsFromIntents,
  combineTools
} from '../tools/definitions';
import type { ExecutorInput, ExecutorTrace, ToolCallLog } from '../types';
import { buildExecutorPrompt, formatIntentLogs } from './executor-prompt';
import { amostragemDoModelo } from './modelo-params';

/**
 * O Executor NÃO usa o `model_name` do agente: ele roda sempre neste modelo, que é
 * mais barato e só precisa escolher ferramenta e preencher argumento. Trocar o
 * modelo de um agente no painel muda o Orquestrador, não esta chamada.
 */
const MODELO_EXECUTOR = 'gpt-5.4-mini';

// Mesmo teto de relógio do orquestrador (ver LLM_TIMEOUT_MS lá): antes o único
// limite era de rodadas, e 8 rodadas sem timeout não têm teto de tempo nenhum.
const openai = new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 1 });

const MAX_TOOL_ROUNDS = 8;

// ── System prompt do Executor ─────────────────────────────────
// `formatIntentLogs` mora em executor-prompt.ts, junto do prompt, para ter teste.


// ── Executor Agent (OpenAI tool calling loop) ─────────────────

export interface ExecutorResult {
  result: string;
  trace: ExecutorTrace;
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorResult> {
  const [intentsOuNull, intentLogs] = await Promise.all([
    getAgentIntents(input.agent_id),
    getIntentLogs(input.agent_id, input.conversation_id),
  ]);

  // `null` = erro de leitura no Supabase, distinto de "agente sem intents"
  // ([]). Aqui o fail-open é tratar como sem intents dinâmicas neste turno —
  // mas com log explícito, pra não confundir com o caso real na hora de
  // investigar um agente que "esqueceu" de chamar uma intent.
  if (intentsOuNull === null) {
    console.error(`[Executor] getAgentIntents falhou (erro de leitura) — turno segue sem intents dinâmicas (agent_id=${input.agent_id})`);
  }
  const intents = intentsOuNull ?? [];

  // Cria tools dinâmicas a partir das intents do banco
  const dynamicTools = createDynamicToolsFromIntents(intents);
  const allTools = combineTools(EXECUTOR_TOOLS, dynamicTools);
  
  // Cria um Set com os nomes das intents para lookup rápido
  const intentSlugs = new Set(intents.map(intent => intent.slug));

  const systemPrompt = buildExecutorPrompt(formatIntentLogs(intentLogs));

  const contextBlock = input.conversation_context
    ? `<historico_conversa>\n${input.conversation_context}\n</historico_conversa>\n\n`
    : '';

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `${contextBlock}<mensagem_atual_do_cliente>\n${input.client_messages}\n</mensagem_atual_do_cliente>\n\n<tarefas>\n${input.query}\n</tarefas>`,
    },
  ];

  const tools = toOpenAITools(allTools);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let usedModel = 'gpt-4.1-mini';
  let rounds = 0;
  const toolsCalledLog: ToolCallLog[] = [];

  const buildTrace = (finalResult: string): ExecutorResult => {
    const cost_usd = calcCostUsd(usedModel, totalInputTokens, totalOutputTokens, totalCachedTokens);
    return {
      result: finalResult,
      trace: {
        called: true,
        rounds,
        model: usedModel,
        tokens_input: totalInputTokens,
        tokens_output: totalOutputTokens,
        cost_usd,
        tools_called: toolsCalledLog,
        query: input.query,
        result: finalResult,
      },
    };
  };

  let esgotouPorPrazo = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Orçamento agregado do turno (ver services/deadline.ts) — checado ANTES de
    // gastar mais uma rodada. Sem isto, MAX_TOOL_ROUNDS=8 só limita QUANTIDADE
    // de chamadas, nunca o relógio; o orquestrador pode ter herdado quase nada
    // de orçamento e o executor continuaria as 8 rodadas do mesmo jeito.
    if (input.deadline?.expired()) {
      esgotouPorPrazo = true;
      break;
    }
    rounds = round + 1;
    const response = await openai.chat.completions.create({
      model: MODELO_EXECUTOR,
      messages,
      tools,
      tool_choice: 'auto',
      ...amostragemDoModelo(MODELO_EXECUTOR, 0.3),
    }, { timeout: capTimeout(60_000, input.deadline) });

    const msg = response.choices[0].message;
    totalCachedTokens += response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    totalInputTokens  += response.usage?.prompt_tokens     ?? 0;
    totalOutputTokens += response.usage?.completion_tokens ?? 0;
    usedModel = response.model;

    // Sem tool calls → resposta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // buildTokenLogEntry (services/pricing.ts) grava pricing_version: 2 — SPEC-01.
      await saveTokenUsage(buildTokenLogEntry({
        agent_id: input.agent_id,
        conversation_id: input.conversation_id,
        lead_id: input.lead_id,
        model: usedModel,
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        tokensCached: totalCachedTokens,
      }));
      return buildTrace(msg.content ?? '(sem resposta)');
    }

    // Processa tool calls
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      let result: string;

      // Verifica se é uma tool estática
      if (toolName === 'atualizar_lead_crm') {
        result = await handleAtualizarLeadCRM(args as { stage: string }, input);
      } else if (toolName === 'enviar_arquivo') {
        result = await handleEnviarArquivo(args as { file_url: string }, input);
      } else if (toolName === 'agent_knowledge_base') {
        result = await handleKnowledgeBase(args as { query: string }, input);
      } 
      // Verifica se é uma intent dinâmica
      else if (intentSlugs.has(toolName)) {
        result = await handleExecutarIntent(
          { intent_key: toolName, arguments: args },
          input
        );
      } 
      // Tool desconhecida
      else {
        result = JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
      }

      // Registra no log
      let parsedResult: unknown = result;
      try { parsedResult = JSON.parse(result); } catch { /* mantém string */ }
      toolsCalledLog.push({ tool: toolName, arguments: args, result: parsedResult });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Chegou no limite de rounds OU estourou o orçamento de tempo — salva tokens
  // e retorna o que tem. Mesmo bloco pros dois casos; o que muda é a mensagem,
  // pra quem olha `agent_error_logs` não confundir "muitas rodadas" com
  // "sem tempo" — são causas e consertos diferentes.
  await saveTokenUsage(buildTokenLogEntry({
    agent_id: input.agent_id,
    conversation_id: input.conversation_id,
    lead_id: input.lead_id,
    model: usedModel,
    tokensIn: totalInputTokens,
    tokensOut: totalOutputTokens,
    tokensCached: totalCachedTokens,
  }));

  await logError({
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: input.lead_id,
    error_message: esgotouPorPrazo
      ? `Executor abortado por orçamento de tempo do turno esgotado (round ${rounds})`
      : `Executor atingiu limite de ${MAX_TOOL_ROUNDS} rounds`,
    provider_failed: 'openai',
    layer: esgotouPorPrazo ? 'executor-deadline' : 'executor',
  });

  return buildTrace(
    esgotouPorPrazo ? '(orçamento de tempo do turno esgotado)' : '(executor atingiu limite de execução)'
  );
}
