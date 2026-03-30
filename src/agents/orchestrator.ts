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

// ── Detecção de saudação/despedida pura ──────────────────────
// Mensagens curtas de cumprimento não precisam de busca na base de conhecimento.
// Para tudo o mais, forçamos o executor no primeiro round.

const GREETING_PATTERNS = [
  /^(oi|olá|ola|hey|hi|hello|e aí|eai|eae|opa|oie)\b/i,
  /^(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)\b/i,
  /^(tchau|até mais|ate mais|até logo|ate logo|adeus|flw|falou|valeu|obrigad[oa]|muito obrigad[oa]|thanks|thank you)\b/i,
];

function isGreetingOrFarewell(message: string): boolean {
  const trimmed = message.trim();
  // Só aplica a mensagens curtas — saudações puras raramente passam de 50 chars
  if (trimmed.length > 50) return false;
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
}

// ── Schema de output injetado no system_prompt ────────────────
// Garante que o modelo saiba exatamente o formato esperado,
// independente do que o n8n colocar no system_prompt.
const OUTPUT_SCHEMA_SUFFIX = `

---

# FORMATO DE RESPOSTA — OBRIGATÓRIO
Responda SOMENTE com JSON válido no formato abaixo. Nenhum texto fora do JSON.

\`\`\`json
{
  "mensagens": ["mensagem 1", "mensagem 2"],
  "redirect_human": false,
  "transfer_reason": null
}
\`\`\`

- **mensagens**: array de strings. Quebre em múltiplas mensagens curtas quando fizer sentido para WhatsApp. Nunca retorne um array vazio.
- **redirect_human**: \`true\` apenas se precisar transferir para humano, caso contrário \`false\`.
- **transfer_reason**: quando \`redirect_human\` for \`true\`, preencha com o motivo da transferência em uma frase curta (ex: "Cliente solicitou atendimento humano", "Dúvida sobre contrato fora do escopo"). Quando \`false\`, use \`null\`.
- **Proibido**: nunca termine mensagens com frases genéricas de encerramento como "Se precisar de mais alguma coisa, é só avisar!", "Fico à disposição!", "Qualquer dúvida estou aqui!" ou similares. Encerre de forma natural e direta, sem filler.`;

// ── Formata mensagem do cliente conforme o tipo ───────────────
// Garante que o LLM entenda que análises de imagem/áudio não são textos digitados pelo cliente.

function formatClientMessage(content: string, type?: string): string {
  switch (type) {
    case 'image_analysis':
      return `[O cliente enviou uma imagem. A descrição abaixo foi gerada automaticamente — não é texto digitado pelo cliente.]\n\n${content}`;
    case 'audio_transcription':
      return `[O cliente enviou um áudio. A transcrição abaixo foi gerada automaticamente.]\n\n${content}`;
    default:
      return content;
  }
}

// Prefixo curto para salvar no histórico Redis (legível nas próximas turns)
function historyPrefix(type?: string): string {
  switch (type) {
    case 'image_analysis':     return '[Imagem] ';
    case 'audio_transcription': return '[Áudio] ';
    default:                   return '';
  }
}

// ── Monta contexto das últimas mensagens para o Executor ──────
function buildConversationContext(history: ChatMessage[]): string {
  const recent = history.slice(-6);
  if (!recent.length) return '';
  return recent
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`)
    .join('\n');
}

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
    mensagens: ['Só um momento, por favor.'],
    redirect_human: true,
    transfer_reason: 'Erro interno — fallback de segurança',
    logs: {
      history,
      orchestrator: { provider: '', model: '', rounds: 0, tokens_input: 0, tokens_output: 0, cost_usd: 0 },
      executor: EMPTY_EXECUTOR_TRACE,
      ...logs,
    },
  };
}

// ── Parse do output do Orquestrador ──────────────────────────

type ParsedOutput = { mensagens: string[]; redirect_human: boolean; transfer_reason?: string };

function normalizeparsed(parsed: Record<string, unknown>): ParsedOutput | null {
  const redirect = Boolean(parsed.redirect_human ?? false);
  const reason   = redirect && typeof parsed.transfer_reason === 'string' && parsed.transfer_reason.trim()
    ? parsed.transfer_reason.trim()
    : undefined;

  // { mensagens: string[] }
  if (Array.isArray(parsed.mensagens)) {
    const mensagens = parsed.mensagens.map(String).filter((m) => m.trim() !== '');
    return { mensagens, redirect_human: redirect, transfer_reason: reason };
  }

  // { mensagens: string }
  if (typeof parsed.mensagens === 'string' && parsed.mensagens.trim()) {
    return { mensagens: [parsed.mensagens.trim()], redirect_human: redirect, transfer_reason: reason };
  }

  // { mensagem: string }
  if (typeof parsed.mensagem === 'string' && parsed.mensagem.trim()) {
    return { mensagens: [parsed.mensagem.trim()], redirect_human: redirect, transfer_reason: reason };
  }

  return null;
}

function parseOrchestratorOutput(raw: string): ParsedOutput {
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
  communications: Array<{ query: string; result: string }>;
}

// ── OpenAI Orchestrator ───────────────────────────────────────
async function runOpenAI(req: ChatRequest, history: ChatMessage[]): Promise<ProviderResult> {
  const tools = toOpenAITools(ORCHESTRATOR_TOOLS);
  const conversationContext = buildConversationContext(history);
  const forceExecutor = !isGreetingOrFarewell(req.client_messages);
  const formattedMessage = formatClientMessage(req.client_messages, req.client_message_type);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system_prompt + OUTPUT_SCHEMA_SUFFIX },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.tools?.length
        ? `${m.content}\n[ferramentas acionadas: ${m.tools.join(', ')}]`
        : m.content,
    })),
    { role: 'user', content: formattedMessage },
  ];

  let totalIn = 0, totalOut = 0, rounds = 0;
  const allExecutorTraces: ExecutorTrace[] = [];
  const communications: Array<{ query: string; result: string }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    // Round 0: força o executor (exceto em saudações/despedidas)
    // Rounds seguintes: auto — o modelo decide se precisa de mais informações
    const toolChoice = (round === 0 && forceExecutor) ? 'required' : 'auto';
    const response = await openai.chat.completions.create({
      model: req.model_name,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: 0.2,
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
        communications,
      };
    }

    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as { tasks: unknown[] };
      const query = JSON.stringify(args.tasks ?? []);
      const executorResult = await runExecutor({
        query,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
        conversation_context: conversationContext,
      });
      allExecutorTraces.push(executorResult.trace);
      communications.push({ query, result: executorResult.result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: executorResult.result });
    }
  }

  throw new Error('OpenAI orchestrator hit max rounds');
}

// ── Anthropic Orchestrator ────────────────────────────────────

async function runAnthropic(req: ChatRequest, history: ChatMessage[]): Promise<ProviderResult> {
  const tools = toAnthropicTools(ORCHESTRATOR_TOOLS);
  const conversationContext = buildConversationContext(history);
  const forceExecutor = !isGreetingOrFarewell(req.client_messages);
  const formattedMessage = formatClientMessage(req.client_messages, req.client_message_type);

  type AnthropicMsg = Anthropic.MessageParam;
  const messages: AnthropicMsg[] = [
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.tools?.length
        ? `${m.content}\n[ferramentas acionadas: ${m.tools.join(', ')}]`
        : m.content,
    })),
    { role: 'user', content: formattedMessage },
  ];

  let totalIn = 0, totalOut = 0, rounds = 0;
  const usedModel = req.model_name;
  const allExecutorTraces: ExecutorTrace[] = [];
  const communications: Array<{ query: string; result: string }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
    // Round 0: força o executor (exceto em saudações/despedidas)
    const toolChoice: Anthropic.MessageCreateParams['tool_choice'] =
      (round === 0 && forceExecutor) ? { type: 'any' } : { type: 'auto' };
    const response = await anthropic.messages.create({
      model: usedModel,
      max_tokens: 4096,
      system: req.system_prompt + OUTPUT_SCHEMA_SUFFIX,
      messages,
      tools: tools as Anthropic.Tool[],
      tool_choice: toolChoice,
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
        communications,
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const args = block.input as { tasks: unknown[] };
      const query = JSON.stringify(args.tasks ?? []);
      const executorResult = await runExecutor({
        query,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
        conversation_context: conversationContext,
      });
      allExecutorTraces.push(executorResult.trace);
      communications.push({ query, result: executorResult.result });
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

  console.log(`[Orchestrator] provider=${providerUsed} model=${result.model} tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} executorCalled=${result.executorTrace.called}`);

  const parsed = parseOrchestratorOutput(result.output);

  // Atualiza histórico Redis — salva o texto limpo das mensagens, não o JSON bruto.
  // Isso evita que o modelo veja JSON estrutural no histórico em vez de linguagem natural.
  const assistantContent = parsed.mensagens.join('\n');
  const toolsUsed = result.executorTrace.called
    ? result.executorTrace.tools_called.map((t) => t.tool)
    : undefined;
  await appendHistory(scopedClientId, [
    { role: 'user',      content: historyPrefix(req.client_message_type) + req.client_messages },
    { role: 'assistant', content: assistantContent, tools: toolsUsed },
  ]);

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
    communication: result.communications.length > 0 ? result.communications : undefined,
  };

  return { ...parsed, logs };
}
