import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
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
  toAnthropicTools,
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
 *
 * Exceção: na reserva de crédito (`input.provider === 'anthropic'`, ver
 * services/credito.ts) o modelo é `config.fallbackAnthropicExecutorModel`.
 */
const MODELO_EXECUTOR = 'gpt-5.4-mini';

// Mesmo teto de relógio do orquestrador (ver LLM_TIMEOUT_MS lá): antes o único
// limite era de rodadas, e 8 rodadas sem timeout não têm teto de tempo nenhum.
const openai = new OpenAI({ apiKey: config.openaiApiKey, timeout: 60_000, maxRetries: 1 });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: 60_000, maxRetries: 1 });

const MAX_TOOL_ROUNDS = 8;

// ── System prompt do Executor ─────────────────────────────────
// `formatIntentLogs` mora em executor-prompt.ts, junto do prompt, para ter teste.


// ── Executor Agent (tool calling loop) ────────────────────────

export interface ExecutorResult {
  result: string;
  trace: ExecutorTrace;
}

/** Tudo que o loop de um provedor precisa; montado uma vez em `runExecutor`. */
interface ContextoExecutor {
  input: ExecutorInput;
  allTools: ReturnType<typeof combineTools>;
  intentSlugs: Set<string>;
  systemPrompt: string;
  userContent: string;
}

/** Contabilidade do turno do Executor, igual para os dois provedores. */
interface Contabilidade {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  model: string;
  rounds: number;
  toolsCalled: ToolCallLog[];
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
  const userContent = `${contextBlock}<mensagem_atual_do_cliente>\n${input.client_messages}\n</mensagem_atual_do_cliente>\n\n<tarefas>\n${input.query}\n</tarefas>`;

  const ctx: ContextoExecutor = { input, allTools, intentSlugs, systemPrompt, userContent };
  return input.provider === 'anthropic' ? loopAnthropic(ctx) : loopOpenAI(ctx);
}

// ── Dispatch de ferramenta (compartilhado pelos dois provedores) ──

async function despacharFerramenta(
  toolName: string,
  args: Record<string, unknown>,
  input: ExecutorInput,
  intentSlugs: Set<string>,
): Promise<string> {
  // Verifica se é uma tool estática
  if (toolName === 'atualizar_lead_crm') {
    return handleAtualizarLeadCRM(args as { stage: string }, input);
  }
  if (toolName === 'enviar_arquivo') {
    return handleEnviarArquivo(args as { file_url: string }, input);
  }
  if (toolName === 'agent_knowledge_base') {
    return handleKnowledgeBase(args as { query: string }, input);
  }
  // Verifica se é uma intent dinâmica
  if (intentSlugs.has(toolName)) {
    return handleExecutarIntent({ intent_key: toolName, arguments: args }, input);
  }
  // Tool desconhecida
  return JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
}

function registrarChamada(c: Contabilidade, tool: string, args: Record<string, unknown>, result: string): void {
  let parsedResult: unknown = result;
  try { parsedResult = JSON.parse(result); } catch { /* mantém string */ }
  c.toolsCalled.push({ tool, arguments: args, result: parsedResult });
}

function montarResultado(input: ExecutorInput, c: Contabilidade, finalResult: string): ExecutorResult {
  const cost_usd = calcCostUsd(c.model, c.tokensIn, c.tokensOut, c.tokensCached);
  return {
    result: finalResult,
    trace: {
      called: true,
      rounds: c.rounds,
      model: c.model,
      tokens_input: c.tokensIn,
      tokens_output: c.tokensOut,
      cost_usd,
      tools_called: c.toolsCalled,
      query: input.query,
      result: finalResult,
    },
  };
}

async function salvarUso(input: ExecutorInput, c: Contabilidade): Promise<void> {
  // buildTokenLogEntry (services/pricing.ts) grava pricing_version: 2 — SPEC-01.
  await saveTokenUsage(buildTokenLogEntry({
    agent_id: input.agent_id,
    conversation_id: input.conversation_id,
    lead_id: input.lead_id,
    model: c.model,
    tokensIn: c.tokensIn,
    tokensOut: c.tokensOut,
    tokensCached: c.tokensCached,
  }));
}

// Chegou no limite de rounds OU estourou o orçamento de tempo — salva tokens
// e retorna o que tem. Mesmo bloco pros dois casos; o que muda é a mensagem,
// pra quem olha `agent_error_logs` não confundir "muitas rodadas" com
// "sem tempo" — são causas e consertos diferentes.
async function encerrarSemResposta(
  input: ExecutorInput,
  c: Contabilidade,
  esgotouPorPrazo: boolean,
  provider: 'openai' | 'anthropic',
): Promise<ExecutorResult> {
  await salvarUso(input, c);

  await logError({
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: input.lead_id,
    error_message: esgotouPorPrazo
      ? `Executor abortado por orçamento de tempo do turno esgotado (round ${c.rounds})`
      : `Executor atingiu limite de ${MAX_TOOL_ROUNDS} rounds`,
    provider_failed: provider,
    layer: esgotouPorPrazo ? 'executor-deadline' : 'executor',
  });

  return montarResultado(
    input,
    c,
    esgotouPorPrazo ? '(orçamento de tempo do turno esgotado)' : '(executor atingiu limite de execução)',
  );
}

// ── OpenAI (caminho normal) ───────────────────────────────────

async function loopOpenAI({ input, allTools, intentSlugs, systemPrompt, userContent }: ContextoExecutor): Promise<ExecutorResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const tools = toOpenAITools(allTools);
  const c: Contabilidade = { tokensIn: 0, tokensOut: 0, tokensCached: 0, model: 'gpt-4.1-mini', rounds: 0, toolsCalled: [] };
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
    c.rounds = round + 1;
    const response = await openai.chat.completions.create({
      model: MODELO_EXECUTOR,
      messages,
      tools,
      tool_choice: 'auto',
      ...amostragemDoModelo(MODELO_EXECUTOR, 0.3),
    }, { timeout: capTimeout(60_000, input.deadline) });

    const msg = response.choices[0].message;
    c.tokensCached += response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    c.tokensIn     += response.usage?.prompt_tokens     ?? 0;
    c.tokensOut    += response.usage?.completion_tokens ?? 0;
    c.model = response.model;

    // Sem tool calls → resposta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      await salvarUso(input, c);
      return montarResultado(input, c, msg.content ?? '(sem resposta)');
    }

    // Processa tool calls
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      const result = await despacharFerramenta(toolName, args, input, intentSlugs);
      registrarChamada(c, toolName, args, result);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
    }
  }

  return encerrarSemResposta(input, c, esgotouPorPrazo, 'openai');
}

// ── Anthropic (reserva de crédito) ────────────────────────────
// Mesmo manual, mesmas ferramentas, mesmo dispatch e mesma contabilidade do
// caminho OpenAI; muda só o formato da conversa (tool_use → tool_result) e o
// modelo. Só é chamado quando o Orquestrador está em modo reserva.

async function loopAnthropic({ input, allTools, intentSlugs, systemPrompt, userContent }: ContextoExecutor): Promise<ExecutorResult> {
  const model = config.fallbackAnthropicExecutorModel;
  const tools = toAnthropicTools(allTools) as Anthropic.Tool[];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];
  const c: Contabilidade = { tokensIn: 0, tokensOut: 0, tokensCached: 0, model, rounds: 0, toolsCalled: [] };
  let esgotouPorPrazo = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (input.deadline?.expired()) {
      esgotouPorPrazo = true;
      break;
    }
    c.rounds = round + 1;
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: 'auto' },
    }, { timeout: capTimeout(60_000, input.deadline) });

    // Na Anthropic o input cacheado vem FORA de `input_tokens` (ao contrário da
    // OpenAI): soma nos dois, igual ao `runAnthropic` do orquestrador.
    const cached =
      (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
    c.tokensIn     += response.usage.input_tokens + cached;
    c.tokensCached += cached;
    c.tokensOut    += response.usage.output_tokens;
    c.model = response.model || model;

    if (response.stop_reason !== 'tool_use') {
      const texto = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      await salvarUso(input, c);
      return montarResultado(input, c, texto || '(sem resposta)');
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const args = (block.input ?? {}) as Record<string, unknown>;
      const result = await despacharFerramenta(block.name, args, input, intentSlugs);
      registrarChamada(c, block.name, args, result);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return encerrarSemResposta(input, c, esgotouPorPrazo, 'anthropic');
}
