import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getHistory, appendHistory } from '../memory/redis';
import { saveTokenUsage, calcCostUsd, inferModelProvider, logError } from '../services/supabase';
import { runExecutor } from './executor';
import { ORCHESTRATOR_TOOLS, toOpenAITools, toAnthropicTools } from '../tools/definitions';
import type { ChatRequest, ChatResponse, ChatMessage, ExecutorTrace, ExecutionLogs } from '../types';

const openai    = new OpenAI({ apiKey: config.openaiApiKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ROUNDS = 5;

const EMPTY_EXECUTOR_TRACE: ExecutorTrace = {
  called: false,
  rounds: 0,
  model: '',
  tokens_input: 0,
  tokens_output: 0,
  cost_usd: 0,
  tools_called: [],
};

function makeFallback(history: ChatMessage[], logs?: Partial<ExecutionLogs>): ChatResponse {
  return {
    mensagens: ['Desculpe, estou com uma instabilidade no momento. Pode tentar novamente em instantes? 🙏'],
    redirect_human: false,
    logs: {
      history,
      orchestrator: { provider: '', model: '', rounds: 0, tokens_input: 0, tokens_output: 0, cost_usd: 0 },
      executor: EMPTY_EXECUTOR_TRACE,
      ...logs,
    },
  };
}

// ── Parse do output do Orquestrador ──────────────────────────

function normalizeparsed(parsed: Record<string, unknown>): { mensagens: string[]; redirect_human: boolean } | null {
  const redirect = Boolean(parsed.redirect_human ?? false);

  // { mensagens: string[] }
  if (Array.isArray(parsed.mensagens)) {
    return { mensagens: parsed.mensagens.map(String), redirect_human: redirect };
  }

  // { mensagens: string }
  if (typeof parsed.mensagens === 'string' && parsed.mensagens.trim()) {
    return { mensagens: [parsed.mensagens.trim()], redirect_human: redirect };
  }

  // { mensagem: string }
  if (typeof parsed.mensagem === 'string' && parsed.mensagem.trim()) {
    return { mensagens: [parsed.mensagem.trim()], redirect_human: redirect };
  }

  return null;
}

function parseOrchestratorOutput(raw: string): { mensagens: string[]; redirect_human: boolean } {
  const fallbackMsg = 'Desculpe, estou com uma instabilidade no momento. Pode tentar novamente em instantes? 🙏';

  try {
    const parsed = JSON.parse(raw);
    const result = normalizeparsed(parsed);
    if (result) return result;
  } catch {}

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const result = normalizeparsed(parsed);
      if (result) return result;
    }
  } catch {}

  const text = raw.trim();
  return {
    mensagens: text ? [text] : [fallbackMsg],
    redirect_human: false,
  };
}

// ── Tipo interno de retorno dos providers ─────────────────────

interface ProviderResult {
  output: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  rounds: number;
  executorTrace: ExecutorTrace;
}

// ── OpenAI Orchestrator ───────────────────────────────────────

async function runOpenAI(req: ChatRequest, history: ChatMessage[]): Promise<ProviderResult> {
  const tools = toOpenAITools(ORCHESTRATOR_TOOLS);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system_prompt },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: req.client_messages },
  ];

  let totalIn = 0, totalOut = 0, rounds = 0;
  const allExecutorTraces: ExecutorTrace[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    const response = await openai.chat.completions.create({
      model: req.model_name,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.5,
    });

    const msg = response.choices[0].message;
    totalIn  += response.usage?.prompt_tokens     ?? 0;
    totalOut += response.usage?.completion_tokens ?? 0;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        output: msg.content ?? '',
        tokensIn: totalIn,
        tokensOut: totalOut,
        model: response.model,
        rounds,
        executorTrace: mergeExecutorTraces(allExecutorTraces),
      };
    }

    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as { input: string };
      const executorResult = await runExecutor({
        query: args.input,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
      });
      allExecutorTraces.push(executorResult.trace);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: executorResult.result });
    }
  }

  throw new Error('OpenAI orchestrator hit max rounds');
}

// ── Anthropic Orchestrator ────────────────────────────────────

async function runAnthropic(req: ChatRequest, history: ChatMessage[]): Promise<ProviderResult> {
  const tools = toAnthropicTools(ORCHESTRATOR_TOOLS);

  type AnthropicMsg = Anthropic.MessageParam;
  const messages: AnthropicMsg[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: req.client_messages },
  ];

  let totalIn = 0, totalOut = 0, rounds = 0;
  const usedModel = req.model_name;
  const allExecutorTraces: ExecutorTrace[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    const response = await anthropic.messages.create({
      model: usedModel,
      max_tokens: 4096,
      system: req.system_prompt,
      messages,
      tools: tools as Anthropic.Tool[],
    });

    totalIn  += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const output = textBlock?.type === 'text' ? textBlock.text : '';
      return {
        output,
        tokensIn: totalIn,
        tokensOut: totalOut,
        model: usedModel,
        rounds,
        executorTrace: mergeExecutorTraces(allExecutorTraces),
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const args = block.input as { input: string };
      const executorResult = await runExecutor({
        query: args.input,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
      });
      allExecutorTraces.push(executorResult.trace);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: executorResult.result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Anthropic orchestrator hit max rounds');
}

// ── Merge de múltiplos traces do executor ─────────────────────

function mergeExecutorTraces(traces: ExecutorTrace[]): ExecutorTrace {
  if (traces.length === 0) return EMPTY_EXECUTOR_TRACE;
  return {
    called: true,
    rounds: traces.reduce((s, t) => s + t.rounds, 0),
    model: traces[traces.length - 1].model,
    tokens_input: traces.reduce((s, t) => s + t.tokens_input, 0),
    tokens_output: traces.reduce((s, t) => s + t.tokens_output, 0),
    cost_usd: traces.reduce((s, t) => s + t.cost_usd, 0),
    tools_called: traces.flatMap((t) => t.tools_called),
  };
}

// ── Orquestrador principal (com fallback) ─────────────────────

export async function runOrchestrator(req: ChatRequest): Promise<ChatResponse> {
  const scopedClientId = `${req.agent_id}:${req.contact_phone}`;
  const history = await getHistory(scopedClientId, 18);

  let result: ProviderResult | null = null;
  let providerUsed = req.model_provider;

  try {
    switch (req.model_provider) {
      case 'openai':    result = await runOpenAI(req, history);    break;
      case 'anthropic': result = await runAnthropic(req, history); break;
      default:          result = await runOpenAI(req, history);
    }
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.error(`[Orchestrator] Provider ${req.model_provider} failed:`, errMsg);

    if (req.model_provider !== 'openai') {
      try {
        console.log('[Orchestrator] Trying OpenAI fallback...');
        providerUsed = 'openai';
        result = await runOpenAI({ ...req, model_name: 'gpt-4.1-mini' }, history);
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        await logError({
          conversation_id: req.conversation_id,
          agent_id: req.agent_id,
          lead_id: req.lead_id,
          error_message: `Primary: ${errMsg} | Fallback: ${fallbackMsg}`,
          provider_failed: `${req.model_provider}+openai`,
          layer: 'orchestrator',
        });
        return makeFallback(history);
      }
    } else {
      await logError({
        conversation_id: req.conversation_id,
        agent_id: req.agent_id,
        lead_id: req.lead_id,
        error_message: errMsg,
        provider_failed: 'openai',
        layer: 'orchestrator',
      });
      return makeFallback(history);
    }
  }

  if (!result) return makeFallback(history);

  // Salva tokens
  const costUsd = calcCostUsd(result.model, result.tokensIn, result.tokensOut);
  await saveTokenUsage({
    agent_id: req.agent_id,
    conversation_id: req.conversation_id,
    lead_id: req.lead_id,
    model_provider: inferModelProvider(result.model),
    model_name: result.model,
    input_tokens: result.tokensIn,
    output_tokens: result.tokensOut,
    total_tokens: result.tokensIn + result.tokensOut,
    estimated_cost_usd: costUsd,
  });

  // Atualiza histórico Redis
  await appendHistory(scopedClientId, [
    { role: 'user',      content: req.client_messages },
    { role: 'assistant', content: result.output },
  ]);

  console.log(`[Orchestrator] provider=${providerUsed} model=${result.model} tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} executorCalled=${result.executorTrace.called}`);

  const parsed = parseOrchestratorOutput(result.output);

  const logs: ExecutionLogs = {
    history,
    orchestrator: {
      provider: providerUsed,
      model: result.model,
      rounds: result.rounds,
      tokens_input: result.tokensIn,
      tokens_output: result.tokensOut,
      cost_usd: costUsd,
    },
    executor: result.executorTrace,
  };

  return { ...parsed, logs };
}
