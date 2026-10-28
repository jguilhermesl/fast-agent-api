import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getAgentIntents, getIntentLogs, getModeloExecutorDoAgente, getExecutorConfereTarefas, saveTokenUsage, calcCostUsd, buildTokenLogEntry, logError } from '../services/supabase';
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
  toAnthropicTools,
  createDynamicToolsFromIntents,
  combineTools
} from '../tools/definitions';
import type { ExecutorInput, ExecutorTrace, ToolCallLog } from '../types';
import { buildExecutorPrompt, formatIntentLogs } from './executor-prompt';
import { amostragemDoModelo } from './modelo-params';
import { escolherModeloExecutor, MODELO_EXECUTOR_PADRAO } from './modelo-executor';
import { textoFixoVizinho } from './texto-fixo-vizinho';
import { intencoesEsquecidas, cobrancaDeTarefas } from './tarefas-esquecidas';
import { systemComCache, ferramentasComCache, mensagensComMarcadorNoFim } from './anthropic-cache';

// O Executor NÃO usa o `model_name` do agente (esse é o do Orquestrador). O dele
// vem de `prompt_config.executor_model`, com `gpt-5.4-mini` como padrão — ver
// modelo-executor.ts para a ordem de escolha e a lista de modelos aceitos.

// Mesmo teto de relógio do orquestrador (ver LLM_TIMEOUT_MS lá): antes o único
// limite era de rodadas, e 8 rodadas sem timeout não têm teto de tempo nenhum.
const openai = new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 1 });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 60_000, maxRetries: 1 });

const MAX_TOOL_ROUNDS = 8;

// ── System prompt do Executor ─────────────────────────────────
// `formatIntentLogs` mora em executor-prompt.ts, junto do prompt, para ter teste.


// ── Executor Agent (OpenAI tool calling loop) ─────────────────

export interface ExecutorResult {
  result: string;
  trace: ExecutorTrace;
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorResult> {
  const [intentsOuNull, intentLogs, modeloDoAgente, confereTarefas] = await Promise.all([
    getAgentIntents(input.agent_id),
    getIntentLogs(input.agent_id, input.conversation_id),
    getModeloExecutorDoAgente(input.agent_id),
    getExecutorConfereTarefas(input.agent_id),
  ]);
  const modelo = escolherModeloExecutor({ doCorpo: input.model, doAgente: modeloDoAgente });

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

  // Uma cobrança por turno: tarefa pedida pelo nome da intenção e não chamada (agents/tarefas-esquecidas.ts).
  let cobrou = false;
  const faltandoParaCobrar = (): string | null => {
    if (!confereTarefas || cobrou) return null;
    const faltam = intencoesEsquecidas(input.query, intents, toolsCalledLog.map((t) => t.tool));
    if (!faltam.length) return null;
    cobrou = true;
    console.warn(`[Executor] tarefa sem chamada, cobrando: ${faltam.map((i) => i.slug).join(', ')} (agent_id=${input.agent_id} conversation=${input.conversation_id})`);
    return cobrancaDeTarefas(faltam);
  };

  // Executa UMA ferramenta pedida pelo modelo, seja qual for o provedor, e registra no log.
  const executarFerramenta = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
    let result: string;
    if (toolName === 'atualizar_lead_crm') {
      result = await handleAtualizarLeadCRM(args as { stage: string }, input);
    } else if (toolName === 'enviar_arquivo') {
      result = await handleEnviarArquivo(args as { file_url: string }, input);
    } else if (toolName === 'agent_knowledge_base') {
      result = await handleKnowledgeBase(args as { query: string }, input);
    } else if (intentSlugs.has(toolName)) {
      const barrado = textoFixoVizinho({ tarefa: input.query, ferramenta: toolName, intentsDoAgente: intentSlugs });
      if (barrado) {
        console.warn(`[Executor] texto fixo vizinho barrado: ${toolName} (agent_id=${input.agent_id} conversation=${input.conversation_id})`);
        result = JSON.stringify({ status: 'error', bloqueado: true, error: barrado });
      } else {
        result = await handleExecutarIntent({ intent_key: toolName, arguments: args }, input);
      }
    } else {
      result = JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
    }
    let parsedResult: unknown = result;
    try { parsedResult = JSON.parse(result); } catch { /* mantém string */ }
    toolsCalledLog.push({ tool: toolName, arguments: args, result: parsedResult });
    return result;
  };

  // ── Caminho Anthropic (modelo claude-*) ──
  // Mesmas ferramentas, mesmo prompt, com cache de prompt (agents/anthropic-cache.ts).
  // Se o Claude falhar ANTES de executar qualquer ferramenta, o turno segue no
  // gpt-5.4-mini e o erro fica em agent_error_logs. Se falhar DEPOIS, não repete:
  // repetir arriscaria executar duas vezes (agendamento, por exemplo).
  let modeloDaVez = modelo;
  let pularOpenAI = false;
  if (modelo.startsWith('claude-')) {
    const toolsAnthropic = ferramentasComCache(toAnthropicTools(allTools) as Anthropic.Tool[]);
    const msgsAnthropic: Anthropic.MessageParam[] = [{ role: 'user', content: messages[1].content as string }];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (input.deadline?.expired()) { esgotouPorPrazo = true; break; }
        rounds = round + 1;
        const response = await anthropic.messages.create({
          model: modelo,
          max_tokens: 8192,
          system: systemComCache(systemPrompt),
          messages: mensagensComMarcadorNoFim(msgsAnthropic),
          tools: toolsAnthropic,
          tool_choice: { type: 'auto' },
        }, { timeout: capTimeout(60_000, input.deadline) });
        const uso = response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        totalInputTokens  += uso.input_tokens + (uso.cache_read_input_tokens ?? 0) + (uso.cache_creation_input_tokens ?? 0);
        totalCachedTokens += uso.cache_read_input_tokens ?? 0;
        totalOutputTokens += uso.output_tokens;
        usedModel = modelo;

        if (response.stop_reason !== 'tool_use') {
          const cobranca = faltandoParaCobrar();
          if (cobranca) {
            msgsAnthropic.push({ role: 'assistant', content: response.content });
            msgsAnthropic.push({ role: 'user', content: cobranca });
            continue;
          }
          await saveTokenUsage(buildTokenLogEntry({
            agent_id: input.agent_id, conversation_id: input.conversation_id, lead_id: input.lead_id,
            model: usedModel, tokensIn: totalInputTokens, tokensOut: totalOutputTokens, tokensCached: totalCachedTokens,
          }));
          const texto = response.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('\n');
          return buildTrace(texto || '(sem resposta)');
        }

        msgsAnthropic.push({ role: 'assistant', content: response.content });
        const resultados: Anthropic.ToolResultBlockParam[] = [];
        for (const bloco of response.content) {
          if (bloco.type !== 'tool_use') continue;
          const resultado = await executarFerramenta(bloco.name, (bloco.input ?? {}) as Record<string, unknown>);
          resultados.push({ type: 'tool_result', tool_use_id: bloco.id, content: resultado });
        }
        msgsAnthropic.push({ role: 'user', content: resultados });
      }
      pularOpenAI = true; // esgotou rodadas ou prazo no Claude: cai no bloco final abaixo
    } catch (err) {
      const erro = err instanceof Error ? err.message : String(err);
      await logError({
        conversation_id: input.conversation_id,
        agent_id: input.agent_id,
        lead_id: input.lead_id,
        error_message: `Executor ${modelo}: ${erro}` + (toolsCalledLog.length ? ' | já tinha executado ferramenta, não repete' : ` | usando ${MODELO_EXECUTOR_PADRAO}`),
        provider_failed: 'anthropic',
        layer: 'executor-fallback',
      });
      if (toolsCalledLog.length) {
        return buildTrace(`FALHA: executor ${modelo} parou no meio (${erro.slice(0, 120)}). Ferramentas já executadas: ${toolsCalledLog.map((t) => t.tool).join(', ')}.`);
      }
      modeloDaVez = MODELO_EXECUTOR_PADRAO;
      rounds = 0;
    }
  }

  for (let round = 0; !pularOpenAI && round < MAX_TOOL_ROUNDS; round++) {
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
      model: modeloDaVez,
      messages,
      tools,
      tool_choice: 'auto',
      ...amostragemDoModelo(modeloDaVez, 0.3),
    }, { timeout: capTimeout(60_000, input.deadline) });

    const msg = response.choices[0].message;
    totalCachedTokens += response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    totalInputTokens  += response.usage?.prompt_tokens     ?? 0;
    totalOutputTokens += response.usage?.completion_tokens ?? 0;
    usedModel = response.model;

    // Sem tool calls → resposta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const cobranca = faltandoParaCobrar();
      if (cobranca) {
        messages.push({ role: 'assistant', content: msg.content ?? '' });
        messages.push({ role: 'user', content: cobranca });
        continue;
      }
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
      const result = await executarFerramenta(toolName, args);

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
