import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getHistory, appendHistory, lockStore, getUltimoTurno, setUltimoTurno, getPendente, setPendente, delPendente } from '../memory/redis';
import { entrarNaFila, sairDaFila, TURN_LOCK_WAIT_MS, type Vez } from '../memory/fila';
import { detectarCruzamento, comNotaDeCruzamento, type MotivoCruzamento } from './cruzamento';
import { cumprimentoDeveCalar } from './saudacao-espera';
import { decidirRajada, ehConversaReal, juntarComPendente, type DecisaoRajada } from './rajada';
import { equipeFalouDepoisDoCliente, JANELA_TURNO_MS, turnoComecaComAtendente } from './atendente-assumiu';
import {
  saveTokenUsage,
  buildTokenLogEntry,
  logError,
  getAgentIntents,
  getIntentLogsCompletos,
  conversaTemCompromissoCriado,
  logGuardShadow,
  getMensagensDoCliente,
  getEstiloResposta,
  getMensagensDaConversa,
  getEstadoDoLead,
  getUltimasMensagensDaConversa,
  getUltimaMensagemAnterior,
  getConfigCotacao,
  getBufferDelayMs,
  getMidiaNoFluxo,
} from '../services/supabase';
import { runExecutor } from './executor';
import { midiasAdiadas, intercalarMidias, paraHistorico, fotosDaBuscaEsquecidas } from './midia-no-fluxo';
import { afirmaAgendamento, garantirAgendamento } from './agendamento-guard';
import { notaDeRetomada, JANELA_DO_TURNO_MS } from './retomada';
import { INSTRUCAO_COTACAO, RESTO_DE_MARCADOR, catalogoDoTurno, resolverMarcadores, temMarcador } from './cotacao';
import { checarGrounding, checarTarefaSemFerramenta, checarValoresSemFonte, historicoConfiavel, MENSAGEM_SEM_LASTRO } from './guard';
import { amostragemDoModelo } from './modelo-params';
import { isGreetingOrFarewell } from './saudacao';
import { prefixoDeClassificacao } from './objecao';
import { sufixoDeSaida } from './formato-saida';
import { systemComCache, ferramentasComCache, mensagensComMarcadorNoFim, separarSystemDoTurno } from './anthropic-cache';
import {
  tarefasEscritasComoTexto,
  comLembrete, ehRecusaDeFerramentaForcada, LEMBRETE_EXECUTOR, LEMBRETE_EXECUTOR_FIRME,
  LEMBRETE_RESPONDER, MAX_CHAMADAS_EXECUTOR_ANTHROPIC, EXECUTOR_NAO_CHAMADO,
} from './anthropic-executor-obrigatorio';
import { parseOrchestratorOutput, entregouAoCliente } from './saida';
import { ORCHESTRATOR_TOOLS, toOpenAITools, toAnthropicTools } from '../tools/definitions';
import { createDeadline, capTimeout, DeadlineExceededError, TURN_BUDGET_MS, type Deadline } from '../services/deadline';
import type { ChatRequest, ChatResponse, ChatMessage, ExecutorTrace, ExecutionLogs } from '../types';

/**
 * Teto de tempo por chamada de LLM.
 *
 * Não havia nenhum: o único limite era de RODADAS (5 aqui, 8 no executor), nunca de
 * relógio. Com o executor podendo segurar até 120 s por tool, o pior caso não tinha
 * teto — e do outro lado da fila há um cliente no WhatsApp esperando. 60 s é folgado
 * para uma resposta que hoje leva ~15 s (p95 medido em 27/08/2026), e corta a cauda.
 *
 * O SDK repete a chamada por conta própria; `maxRetries: 1` evita que o teto real
 * vire 60 s × 3.
 *
 * O que ISTO não resolve: é teto por CHAMADA, não do turno inteiro. Orquestrador
 * (MAX_TOOL_ROUNDS=5) chamando Executor (MAX_TOOL_ROUNDS=8) chamando tool HTTP
 * (até 120s em tools/handlers.ts) ainda podia somar dezenas de minutos no pior
 * caso. Isso é resolvido por `createDeadline`/`capTimeout` (services/deadline.ts),
 * usado logo abaixo em `runOrchestrator`.
 */
const LLM_TIMEOUT_MS = 60_000;

const openai    = new OpenAI({ apiKey: config.openaiApiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });

const MAX_TOOL_ROUNDS = 5;

/** Modelo OpenAI usado quando o provedor principal (Anthropic) falha. */
const MODELO_FALLBACK_OPENAI = 'gpt-5.4';

/** Modelos da Anthropic que já recusaram `tool_choice` any/tool neste processo. */
const modelosSemFerramentaForcada = new Set<string>();

// Detecção de saudação/despedida pura: `./saudacao.ts` (função pura, com teste).
// Mensagens curtas de cumprimento não precisam de busca na base de conhecimento.
// Para tudo o mais, forçamos o executor no primeiro round.

// Pré-classificação de recusa × objeção: `./objecao.ts` (função pura, com teste).
// Até 30/09/2026 "não quero", "não tenho interesse" e "não posso" eram marcados
// como OBJEÇÃO e o agente insistia depois de um não.

// ── Schema de output injetado no system_prompt ────────────────
// Garante que o modelo saiba exatamente o formato esperado,
// independente do que o n8n colocar no system_prompt. O texto mora em
// `./formato-saida.ts` (função pura, com teste) e muda com o `response_style` do
// agente: no `conciso` não manda mais "quebre em múltiplas mensagens".

// ── Formata mensagem do cliente conforme o tipo ───────────────
// Garante que o LLM entenda que análises de imagem/áudio não são textos digitados pelo cliente.

// `nota`: o cliente escreveu antes de receber a resposta anterior (agents/cruzamento.ts).
function formatClientMessage(content: string, type?: string, nota = false, retomada?: string | null): string {
  const formatado = formatarPorTipo(content, type);
  const comCruzamento = nota ? comNotaDeCruzamento(formatado) : formatado;
  return retomada ? `${retomada}

${comCruzamento}` : comCruzamento;
}

function formatarPorTipo(content: string, type?: string): string {
  switch (type) {
    case 'image_analysis':
      return `[O cliente enviou uma imagem. A descrição abaixo foi gerada automaticamente — não é texto digitado pelo cliente.]\n\n${content}`;
    case 'audio_transcription':
      return `[O cliente enviou um áudio. A transcrição abaixo foi gerada automaticamente.]\n\n${content}`;
    default: {
      const prefixo = prefixoDeClassificacao(content);
      return prefixo ? `${prefixo}\n\n${content}` : content;
    }
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

// ── Tipo interno de retorno dos providers ─────────────────────

interface ProviderResult {
  output: string;
  tokensIn: number;
  tokensOut: number;
  /** Fatia de `tokensIn` servida pelo cache de prefixo. Ver TokenLogEntry. */
  tokensCached: number;
  model: string;
  rounds: number;
  executorTrace: ExecutorTrace;
  communications: Array<{ query: string; result: string }>;
}

// ── Valor sem fonte: fontes de fora e reescrita ───────────────

/** Texto curto de quando a reescrita não tirou o valor sem fonte: transfere sem citar número. */
export const MENSAGEM_VALOR_A_CONFIRMAR =
  'Vou confirmar esse valor certinho com a equipe e já te retorno por aqui 😊';

/** Instrução dos marcadores de cotação (agents/cotacao.ts), só para agente com a chave ligada. */
const instrucaoCotacao = (req: ChatRequest): string => (req.cotacao?.ligado ? INSTRUCAO_COTACAO : '');

const normalizarTexto = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * O que foi enviado ao paciente nesta conversa sem passar pelo Orquestrador:
 * texto pronto das intenções `enviar_detalhes_*` (o n8n manda, e o modelo só
 * recebe "Workflow was started") e fala da equipe. É fonte legítima de valor:
 * "a endoscopia fica R$ 430" depois do texto pronto da endoscopia é verdade.
 * Fala da própria IA fica de fora (está no histórico), senão uma alucinação
 * vira lastro de si mesma. Falha de leitura devolve vazio: a checagem fica só
 * mais rígida, nunca mais frouxa.
 */
async function textosEnviadosPorFora(conversationId: string, history: ChatMessage[]): Promise<string> {
  try {
    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const msgs = await getUltimasMensagensDaConversa(conversationId, desde, 60);
    const daIA = history.filter((m) => m.role === 'assistant').map((m) => normalizarTexto(m.content)).join('\n');
    return msgs
      .filter((m) => m.direction === 'outbound' && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => m.content as string)
      .filter((c) => !daIA.includes(normalizarTexto(c).slice(0, 120)))
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Pede ao mesmo modelo que refaça a resposta sem os valores e datas sem fonte.
 * Uma chamada só, SEM ferramentas: refazer o turno inteiro dispararia de novo
 * texto pronto e agendamento. Devolve null se a chamada falhar.
 */
async function reescreverSemValorInventado(
  req: ChatRequest,
  history: ChatMessage[],
  estilo: string | null,
  provider: string,
  result: ProviderResult,
  semFonte: string[],
  fontes: string,
  deadline: Deadline,
): Promise<ReturnType<typeof parseOrchestratorOutput> | null> {
  const instrucao =
    `[Instrução interna, não é do cliente: a sua resposta anterior cita ${semFonte.join(', ')}, ` +
    'e isso não aparece no retorno das ferramentas deste turno, no que já foi enviado nem no seu prompt. ' +
    'Valor e data inventados chegam errados ao paciente. Reescreva a resposta no mesmo formato de saída, ' +
    'usando só valores, datas e profissionais que estão no retorno abaixo. Se o que o cliente pediu não está ' +
    'no retorno, não cite número nem data: diga que vai confirmar com a equipe e transfira.]\n\n' +
    `Retorno das ferramentas e textos já enviados:\n${fontes.slice(0, 15000)}`;
  return reescreverComInstrucao(req, history, estilo, provider, result, instrucao, deadline);
}

/** Uma chamada ao mesmo modelo, SEM ferramentas, com a resposta anterior e uma instrução interna. */
async function reescreverComInstrucao(
  req: ChatRequest,
  history: ChatMessage[],
  estilo: string | null,
  provider: string,
  result: ProviderResult,
  instrucao: string,
  deadline: Deadline,
): Promise<ReturnType<typeof parseOrchestratorOutput> | null> {
  const modelo = provider === req.model_provider ? req.model_name : MODELO_FALLBACK_OPENAI;
  // Mesmo corte do runAnthropic, para reaproveitar o cache da persona; na OpenAI vai inteiro.
  const corte = provider === 'anthropic' ? separarSystemDoTurno(req.system_prompt) : { fixo: req.system_prompt, doTurno: '' };
  const system = corte.fixo + sufixoDeSaida(estilo) + instrucaoCotacao(req);
  const conversa = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: (corte.doTurno ? `${corte.doTurno}\n\n` : '') + formatClientMessage(req.client_messages, req.client_message_type, false, req.nota_retomada) },
    { role: 'assistant' as const, content: result.output || '(vazio)' },
    { role: 'user' as const, content: instrucao },
  ];
  try {
    let texto = '', tokensIn = 0, tokensOut = 0, tokensCached = 0, modeloUsado = modelo;
    if (provider === 'anthropic') {
      const r = await anthropic.messages.create({
        model: modelo,
        max_tokens: 8192,
        system: systemComCache(system),
        messages: mensagensComMarcadorNoFim(conversa),
      }, { timeout: capTimeout(LLM_TIMEOUT_MS, deadline) });
      texto = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      // Mesmo cast de runAnthropic: o SDK fixado não declara os campos de cache.
      const uso = r.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
      tokensIn = (r.usage.input_tokens ?? 0) + (uso.cache_read_input_tokens ?? 0) + (uso.cache_creation_input_tokens ?? 0);
      tokensCached = uso.cache_read_input_tokens ?? 0;
      tokensOut = r.usage.output_tokens ?? 0;
    } else {
      const r = await openai.chat.completions.create({
        model: modelo,
        messages: [{ role: 'system', content: system }, ...conversa],
        ...amostragemDoModelo(modelo, 0.2),
      }, { timeout: capTimeout(LLM_TIMEOUT_MS, deadline) });
      texto = r.choices[0].message.content ?? '';
      tokensIn = r.usage?.prompt_tokens ?? 0;
      tokensOut = r.usage?.completion_tokens ?? 0;
      tokensCached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      modeloUsado = r.model;
    }
    await saveTokenUsage(buildTokenLogEntry({
      agent_id: req.agent_id,
      conversation_id: req.conversation_id,
      lead_id: req.lead_id,
      model: modeloUsado,
      tokensIn,
      tokensOut,
      tokensCached,
    }));
    if (!texto.trim()) return null;
    return parseOrchestratorOutput(texto, entregouAoCliente(result.executorTrace.tools_called));
  } catch (err) {
    console.error('[Lastro] reescrita falhou:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── OpenAI Orchestrator ───────────────────────────────────────
async function runOpenAI(req: ChatRequest, history: ChatMessage[], deadline: Deadline, nota = false, estilo: string | null = null): Promise<ProviderResult> {
  const tools = toOpenAITools(ORCHESTRATOR_TOOLS);
  const conversationContext = buildConversationContext(history);
  const forceExecutor = !isGreetingOrFarewell(req.client_messages);
  const formattedMessage = formatClientMessage(req.client_messages, req.client_message_type, nota, req.nota_retomada);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system_prompt + sufixoDeSaida(estilo) + instrucaoCotacao(req) },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.tools?.length
        ? `${m.content}\n[ferramentas acionadas: ${m.tools.join(', ')}]`
        : m.content,
    })),
    { role: 'user', content: formattedMessage },
  ];

  let totalIn = 0, totalOut = 0, totalCached = 0, rounds = 0;
  const allExecutorTraces: ExecutorTrace[] = [];
  const communications: Array<{ query: string; result: string }> = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Orçamento agregado do turno (services/deadline.ts) — checado antes de
    // gastar mais uma rodada, que pode disparar um Executor de até 8 rodadas.
    if (deadline.expired()) throw new DeadlineExceededError(`orquestrador OpenAI round ${round + 1}`);
    rounds = round + 1;
    // Round 0: força o executor (exceto em saudações/despedidas)
    // Rounds seguintes: auto — o modelo decide se precisa de mais informações
    const toolChoice = (round === 0 && forceExecutor) ? 'required' : 'auto';
    const response = await openai.chat.completions.create({
      model: req.model_name,
      messages,
      tools,
      tool_choice: toolChoice,
      // gpt-5.6 recusa `temperature` e exige `reasoning_effort: 'none'` para
      // aceitar function tools aqui; o resto segue com temperatura fixa.
      ...amostragemDoModelo(req.model_name, 0.2),
    }, { timeout: capTimeout(LLM_TIMEOUT_MS, deadline) });

    const msg = response.choices[0].message;
    totalIn  += response.usage?.prompt_tokens     ?? 0;
    totalOut += response.usage?.completion_tokens ?? 0;
    // `cached_tokens` é subconjunto de `prompt_tokens`, não uma parcela extra.
    totalCached += response.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        output: msg.content ?? '',
        tokensIn: totalIn,
        tokensOut: totalOut,
        tokensCached: totalCached,
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
        deadline,
        model: req.executor_model,
      });
      allExecutorTraces.push(executorResult.trace);
      communications.push({ query, result: executorResult.result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: executorResult.result });
    }
  }

  throw new Error('OpenAI orchestrator hit max rounds');
}

// ── Anthropic Orchestrator ────────────────────────────────────

async function runAnthropic(req: ChatRequest, history: ChatMessage[], deadline: Deadline, nota = false, estilo: string | null = null): Promise<ProviderResult> {
  const tools = toAnthropicTools(ORCHESTRATOR_TOOLS);
  const conversationContext = buildConversationContext(history);
  const forceExecutor = !isGreetingOrFarewell(req.client_messages);
  // Persona fixa no system (cache entre conversas); dados do cliente, horário e CRM
  // vão com a mensagem deste turno (agents/anthropic-cache.ts `separarSystemDoTurno`).
  const { fixo: systemFixo, doTurno } = separarSystemDoTurno(req.system_prompt);
  const formattedMessage =
    (doTurno ? `${doTurno}\n\n` : '') + formatClientMessage(req.client_messages, req.client_message_type, nota, req.nota_retomada);

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

  let totalIn = 0, totalOut = 0, totalCached = 0, rounds = 0;
  const usedModel = req.model_name;
  const allExecutorTraces: ExecutorTrace[] = [];
  const communications: Array<{ query: string; result: string }> = [];

  let lembreteFirmeUsado = false;
  // Cópia do começo (histórico + mensagem do cliente), para a resposta final sem ferramentas.
  const conversaInicial: AnthropicMsg[] = [...messages];
  let chamadasExecutor = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (deadline.expired()) throw new DeadlineExceededError(`orquestrador Anthropic round ${round + 1}`);
    rounds = round + 1;
    // Round 0: o executor é obrigatório (exceto em saudações/despedidas). Modelo que
    // aceita ferramenta forçada recebe `any`; o que recusa (claude-sonnet-5-5, 16/10)
    // vai com `auto` + lembrete interno (agents/anthropic-executor-obrigatorio.ts).
    const obrigatorio = round === 0 && forceExecutor;
    const forcar = obrigatorio && !modelosSemFerramentaForcada.has(usedModel);
    const lembrete = obrigatorio && !forcar ? (lembreteFirmeUsado ? LEMBRETE_EXECUTOR_FIRME : LEMBRETE_EXECUTOR) : null;
    // Cache de prompt (agents/anthropic-cache.ts): ferramentas, system e o fim da
    // conversa vão marcados com `cache_control`; sem isso cada rodada pagava o prompt
    // inteiro. A cópia marcada é montada a cada chamada, `messages` segue sem marca.
    const chamar = (comForca: boolean, texto: string | null) => anthropic.messages.create({
      model: usedModel,
      // 8192: os modelos 5.x podem raciocinar antes de responder, e isso conta aqui.
      max_tokens: 8192,
      system: systemComCache(systemFixo + sufixoDeSaida(estilo) + instrucaoCotacao(req)),
      messages: mensagensComMarcadorNoFim(texto ? comLembrete(messages, texto) : messages),
      tools: ferramentasComCache(tools as Anthropic.Tool[]),
      tool_choice: comForca ? { type: 'any' } : { type: 'auto' },
    }, { timeout: capTimeout(LLM_TIMEOUT_MS, deadline) });
    let response: Anthropic.Message;
    try {
      response = await chamar(forcar, lembrete);
    } catch (err) {
      if (!forcar || !ehRecusaDeFerramentaForcada(err)) throw err;
      modelosSemFerramentaForcada.add(usedModel);
      console.warn(`[Orchestrator] ${usedModel} não aceita ferramenta forçada: segue com auto + lembrete`);
      response = await chamar(false, LEMBRETE_EXECUTOR);
    }

    totalIn  += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    // Na Anthropic o input cacheado (lido e escrito) vem FORA de `input_tokens`, ao
    // contrário da OpenAI: soma os dois no total de input e o lido no contador de
    // cache. O escrito custa 1,25x e entra aqui pela tarifa cheia (subestima 25%
    // da escrita, que só acontece na primeira chamada de cada prefixo).
    // O cast é porque o SDK fixado (^0.27.0) não declara esses campos em `Usage`.
    const uso = response.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const anthropicCached = uso.cache_read_input_tokens ?? 0;
    totalIn     += anthropicCached + (uso.cache_creation_input_tokens ?? 0);
    totalCached += anthropicCached;

    // Rodada 0 obrigatória que terminou sem executor (só acontece no caminho `auto`):
    // descarta a resposta e repete uma vez com o lembrete firme. Se insistir, segue.
    if (response.stop_reason !== 'tool_use' && obrigatorio && !forcar && !lembreteFirmeUsado) {
      lembreteFirmeUsado = true;
      console.warn(`[Orchestrator] ${usedModel} respondeu sem chamar o executor na rodada 0: repetindo com lembrete firme`);
      round -= 1;
      continue;
    }

    // Tarefas escritas como texto em vez de chamada (anthropic-executor-obrigatorio.ts):
    // vira a chamada que o modelo quis fazer, em vez de ir ao paciente como mensagem.
    if (response.stop_reason !== 'tool_use') {
      const blocoTexto = response.content.find((b) => b.type === 'text');
      const tarefas = blocoTexto?.type === 'text' ? tarefasEscritasComoTexto(blocoTexto.text) : null;
      if (tarefas && chamadasExecutor < MAX_CHAMADAS_EXECUTOR_ANTHROPIC) {
        console.warn(`[Orchestrator] ${usedModel} escreveu as tarefas como texto: executando como chamada`);
        response = {
          ...response,
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: `toolu_sintetico_${Date.now()}`, name: 'chamar_executor', input: { tasks: tarefas } } as unknown as Anthropic.ContentBlock],
        };
      }
    }

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const output = textBlock?.type === 'text' ? textBlock.text : '';
      return {
        output,
        tokensIn: totalIn,
        tokensOut: totalOut,
        tokensCached: totalCached,
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
      // Teto de chamadas ao Executor no turno (agents/anthropic-executor-obrigatorio.ts):
      // a terceira não executa e volta pedindo a resposta com o que já tem.
      if (chamadasExecutor >= MAX_CHAMADAS_EXECUTOR_ANTHROPIC) {
        console.warn(`[Orchestrator] ${usedModel} pediu o executor pela ${chamadasExecutor + 1}ª vez no turno: não executado`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: EXECUTOR_NAO_CHAMADO });
        continue;
      }
      chamadasExecutor++;
      const executorResult = await runExecutor({
        query,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
        conversation_context: conversationContext,
        deadline,
        model: req.executor_model,
      });
      allExecutorTraces.push(executorResult.trace);
      communications.push({ query, result: executorResult.result });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: executorResult.result });
    }
    // A instrução de responder vai junto da devolução (sem ela o Claude 5.5 seguia
    // chamando o executor em toda rodada; ver LEMBRETE_RESPONDER).
    messages.push({
      role: 'user',
      content: [...toolResults, { type: 'text', text: LEMBRETE_RESPONDER }] as Anthropic.MessageParam['content'],
    });
  }

  // Esgotou as rodadas pedindo ferramenta (16/10/2026: 1 turno real e 2 de teste caíram
  // no gpt-5.4 assim, com o paciente esperando ~37 s). Antes de desistir do provedor,
  // uma chamada SEM ferramentas, com o que os executores devolveram como texto.
  if (!deadline.expired()) {
    const retornos = communications.map((c) => c.result).join('\n---\n').slice(0, 15000);
    const instrucao =
      '[Instrução interna, não é do cliente: as buscas deste turno já voltaram e estão abaixo. ' +
      'Responda agora ao cliente, no formato de saída, só com o que está aí. Se faltar dado, diga que a equipe confirma.]\n\n' +
      (retornos || '(nenhum retorno)');
    const msgsFinais = comLembrete(conversaInicial, instrucao);
    const final = await anthropic.messages.create({
      model: usedModel,
      max_tokens: 8192,
      system: systemComCache(systemFixo + sufixoDeSaida(estilo) + instrucaoCotacao(req)),
      messages: mensagensComMarcadorNoFim(msgsFinais),
    }, { timeout: capTimeout(LLM_TIMEOUT_MS, deadline) });
    const usoFinal = final.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    totalIn += final.usage.input_tokens + (usoFinal.cache_read_input_tokens ?? 0) + (usoFinal.cache_creation_input_tokens ?? 0);
    totalOut += final.usage.output_tokens;
    totalCached += usoFinal.cache_read_input_tokens ?? 0;
    const texto = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    if (texto.trim()) {
      console.warn(`[Orchestrator] ${usedModel} esgotou as rodadas: resposta final sem ferramentas`);
      return {
        output: texto,
        tokensIn: totalIn,
        tokensOut: totalOut,
        tokensCached: totalCached,
        model: usedModel,
        rounds: rounds + 1,
        executorTrace: mergeExecutorTraces(allExecutorTraces),
        communications,
      };
    }
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

  // Orçamento único do turno, criado aqui — na entrada do request — e
  // propagado pro Executor e pelas tools (services/deadline.ts). Sem isto, só
  // existia teto de RODADAS em cada nível, nunca teto de RELÓGIO agregado.
  // Criado ANTES da fila: a espera pelo turno anterior sai do mesmo teto, então
  // o n8n nunca espera mais do que já esperava.
  const deadline = createDeadline();
  const inicio = Date.now();

  // Um turno por conversa de cada vez (memory/fila.ts): o 2º só lê o histórico
  // depois que o 1º gravou. TTL acima do turno mais longo possível.
  const vez = await entrarNaFila(lockStore, scopedClientId, {
    ttlMs: TURN_BUDGET_MS + 30_000,
    esperaMaxMs: TURN_LOCK_WAIT_MS,
  });
  if (vez.concorrente) {
    console.log(`[Fila] conversation=${req.conversation_id} esperou ${vez.esperouMs}ms pelo turno anterior${vez.token ? '' : ' (seguiu sem lock)'}`);
  }

  let descartado = false;
  try {
    const resposta = await runTurno(req, scopedClientId, deadline, vez, inicio);
    descartado = resposta.logs?.turno?.descartado === true;
    return resposta;
  } finally {
    // Juntos, na mesma conexão: o SET sai antes do EVAL e o Redis executa em
    // ordem, então quem pegar o lock em seguida já lê o registro novo.
    await Promise.all([
      setUltimoTurno(scopedClientId, { inicio, fim: Date.now(), ...(descartado ? { descartado: true } : {}) }),
      sairDaFila(lockStore, scopedClientId, vez),
    ]);
  }
}

/**
 * Leituras da decisão de fim de turno (agents/rajada.ts), em paralelo. Qualquer
 * falha devolve `null` e o turno responde como antes (fail-open).
 */
async function avaliarRajada(
  req: ChatRequest,
  p: { inicio: number; vez: Vez; tools: string[]; redirect: boolean; descartesAnteriores: number },
): Promise<DecisaoRajada | null> {
  try {
    const agora = Date.now();
    const [bufferDelayMs, lead, msgs, ultimo] = await Promise.all([
      getBufferDelayMs(req.agent_id),
      getEstadoDoLead(req.conversation_id),
      // 35 s cobre o maior BufferDelay ativo (30 s) mais a folga.
      getMensagensDaConversa(req.conversation_id, new Date(p.inicio - 35_000).toISOString(), new Date(agora + 1_000).toISOString()),
      getUltimoTurno(req.agent_id + ':' + req.contact_phone),
    ]);
    return decidirRajada({
      inicio: p.inicio,
      agora: Date.now(),
      bufferDelayMs,
      loteTexto: req.client_messages,
      tools: p.tools,
      redirect: p.redirect,
      lockDesde: p.vez.token ? p.inicio + p.vez.esperouMs : null,
      esperaMaxFilaMs: TURN_LOCK_WAIT_MS,
      descartesAnteriores: p.descartesAnteriores,
      inicioUltimoTurno: ultimo?.inicio ?? null,
      lead,
      msgs,
    });
  } catch (err) {
    console.error('[Rajada] decisão falhou, turno responde normal:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function runTurno(req: ChatRequest, scopedClientId: string, deadline: Deadline, vez: Vez, inicio: number): Promise<ChatResponse> {
  // Turno anterior desta rajada foi descartado (agents/rajada.ts): o texto dele
  // entra aqui, antes de tudo, como se o n8n tivesse juntado as duas mensagens.
  // Vale em qualquer RAJADA_MODE: o pendente existe, o cliente escreveu aquilo.
  let juntouPendente = false;
  let descartesAnteriores = 0;
  if (ehConversaReal(req.conversation_id)) {
    const pendente = await getPendente(scopedClientId);
    if (pendente) {
      await delPendente(scopedClientId);
      const j = juntarComPendente(pendente, { texto: req.client_messages, tipo: req.client_message_type ?? 'text' }, Date.now());
      if (j.juntou) {
        req = { ...req, client_messages: j.texto, client_message_type: j.tipo };
        juntouPendente = true;
        descartesAnteriores = j.descartes;
        console.log(`[Rajada] conversation=${req.conversation_id} juntou o texto do turno descartado (descartes=${j.descartes}, idade=${Date.now() - pendente.em}ms)`);
      }
    }
  }

  // Conversa já na equipe quando o turno começa (agents/atendente-assumiu.ts): não
  // chama LLM nem ferramenta. Guarda a fala do cliente, como a rajada faz.
  if (config.atendenteNoInicioMode !== 'off' && ehConversaReal(req.conversation_id)) {
    let comAtendente = false;
    try {
      // Lead em `human`, ou a equipe já respondeu a última fala do cliente com o lead
      // ainda em `ai` (eco atrasado ou em outra conversa, 14/10/2026).
      const agora = Date.now();
      const [estado, ultimas] = await Promise.all([
        getEstadoDoLead(req.conversation_id),
        getUltimasMensagensDaConversa(req.conversation_id, new Date(agora - JANELA_TURNO_MS).toISOString()),
      ]);
      comAtendente = turnoComecaComAtendente(estado) || equipeFalouDepoisDoCliente(ultimas, agora);
    } catch (err) {
      console.error('[Atendente] leitura do lead falhou, turno segue:', err instanceof Error ? err.message : String(err));
    }
    if (comAtendente) {
      console.log(`[Atendente] conversation=${req.conversation_id} conversa com a equipe no início do turno modo=${config.atendenteNoInicioMode}`);
      if (config.atendenteNoInicioMode === 'calar') {
        await appendHistory(scopedClientId, [
          { role: 'user', content: historyPrefix(req.client_message_type) + req.client_messages },
        ]);
        return { ...makeFallback([]), mensagens: [], redirect_human: false, transfer_reason: undefined };
      }
    }
  }

  // Cumprimento sozinho com a pergunta já na conversa (agents/saudacao-espera.ts):
  // cala, e o turno da pergunta responde tudo. Roda dentro da fila da conversa.
  if (req.client_message_type === 'text' && isGreetingOrFarewell(req.client_messages)) {
    const calar = await cumprimentoDeveCalar(
      { getMensagensDoCliente, esperar: (ms) => new Promise((r) => setTimeout(r, capTimeout(ms, deadline))) },
      { conversationId: req.conversation_id, inicioTurno: inicio, clientMessages: req.client_messages },
    );
    if (calar) {
      console.log(`[Saudação] conversation=${req.conversation_id} cumprimento calado: há fala do cliente fora deste turno`);
      return { ...makeFallback([]), mensagens: [], redirect_human: false, transfer_reason: undefined };
    }
  }

  // Cruzamento (agents/cruzamento.ts) em paralelo com o histórico: só vai ao
  // Supabase quando o turno anterior acabou há até 45 s.
  // `response_style` do agente (painel → prompt_config): o n8n não manda no corpo,
  // então vem do banco, com cache curto. Falha de leitura = null = sufixo de antes.
  const [history, cruzamento, estilo, ultimaAnterior, cfgCotacao] = await Promise.all([
    getHistory(scopedClientId, 18),
    config.cruzamentoMode === 'off'
      ? Promise.resolve<MotivoCruzamento | null>(null)
      : detectarCruzamento(
          { getUltimoTurno, getMensagensDoCliente },
          { scopedClientId, conversationId: req.conversation_id, esperouNaFila: vez.concorrente },
        ),
    getEstiloResposta(req.agent_id),
    // Conversa retomada depois de pausa longa (agents/retomada.ts). Falha = sem nota.
    getUltimaMensagemAnterior(req.conversation_id, new Date(Date.now() - JANELA_DO_TURNO_MS).toISOString()).catch(() => null),
    getConfigCotacao(req.agent_id),
  ]);
  // Cotação no código (agents/cotacao.ts): chave do agente, ou o corpo (só a suíte manda).
  req = { ...req, cotacao: { ligado: req.cotacao_no_codigo ?? cfgCotacao.ligado, titulos: cfgCotacao.titulos } };
  const notaRetomada = notaDeRetomada(ultimaAnterior, Date.now(), history.length > 0);
  if (notaRetomada) {
    console.log(`[Retomada] conversation=${req.conversation_id} última anterior=${ultimaAnterior}`);
    req = { ...req, nota_retomada: notaRetomada };
  }
  const nota = cruzamento !== null && config.cruzamentoMode === 'nota';
  if (cruzamento) {
    console.log(`[Cruzamento] conversation=${req.conversation_id} motivo=${cruzamento} modo=${config.cruzamentoMode}`);
  }

  let result: ProviderResult | null = null;
  let providerUsed = req.model_provider;

  try {
    switch (req.model_provider) {
      case 'openai':    result = await runOpenAI(req, history, deadline, nota, estilo);    break;
      case 'anthropic': result = await runAnthropic(req, history, deadline, nota, estilo); break;
      /**
       * Provedor fora dos dois implementados.
       *
       * O `default` chamava `runOpenAI(req)` direto — mantendo `req.model_name`. Com
       * `model_provider: 'gemini'` isso mandava `gemini-2.5-pro` para o cliente da
       * OpenAI, que devolve 400; o catch abaixo via "provider !== openai", caía no
       * fallback e o agente passava a rodar `gpt-4.1-mini` PARA SEMPRE, sem nenhum
       * sinal na tela. O painel dizia "Gemini 2.5 Pro · Mais capaz".
       *
       * `throw` aqui não piora a experiência do cliente: o mesmo catch já trata, o
       * fallback continua respondendo. A diferença é que agora o motivo chega em
       * `agent_error_logs` com o nome do provedor, em vez de se disfarçar de erro
       * transitório da OpenAI.
       */
      default:
        throw new Error(
          `model_provider "${req.model_provider}" não implementado (só openai e anthropic). ` +
          `Agente ${req.agent_id} está configurado num provedor que este serviço não roda.`,
        );
    }
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.error(`[Orchestrator] Provider ${req.model_provider} failed:`, errMsg);

    // Orçamento do turno já esgotado: tentar o fallback OpenAI gastaria MAIS
    // tempo do que já não sobra — o oposto do que o orçamento existe pra
    // garantir. Vai direto pro fallback de segurança, sem nova chamada de rede.
    if (primaryErr instanceof DeadlineExceededError) {
      await logError({
        conversation_id: req.conversation_id,
        agent_id: req.agent_id,
        lead_id: req.lead_id,
        error_message: errMsg,
        provider_failed: req.model_provider,
        layer: 'orchestrator-deadline',
      });
      return makeFallback(history);
    }

    if (req.model_provider !== 'openai') {
      // A falha do provedor principal fica registrada MESMO quando o fallback
      // responde. Antes só gravava se os dois falhassem, e Priscila e Dani rodaram
      // semanas caladas em gpt-4.1-mini com a chave da Anthropic dando 401. Com o
      // registro, o alerta de crédito do n8n (agent_error_logs) também enxerga o
      // saldo da Anthropic acabando.
      await logError({
        conversation_id: req.conversation_id,
        agent_id: req.agent_id,
        lead_id: req.lead_id,
        error_message: `Primary ${req.model_provider}/${req.model_name}: ${errMsg} | usando fallback openai/${MODELO_FALLBACK_OPENAI}`,
        provider_failed: req.model_provider,
        layer: 'orchestrator-fallback',
      });
      try {
        console.log('[Orchestrator] Trying OpenAI fallback...');
        providerUsed = 'openai';
        // gpt-5.4: o modelo em que os agentes foram validados. O gpt-4.1-mini de
        // antes respondia, mas pior, e ninguém percebia (ver logError acima).
        result = await runOpenAI({ ...req, model_name: MODELO_FALLBACK_OPENAI }, history, deadline, nota, estilo);
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

  // Salva tokens. `buildTokenLogEntry` (services/pricing.ts) é quem grava
  // `pricing_version: 2` — ver SPEC-01 na migration 20260822143000. Reaproveita
  // o mesmo cálculo pra `costUsd` abaixo em vez de rodar `calcCostUsd` de novo.
  const tokenEntry = buildTokenLogEntry({
    agent_id: req.agent_id,
    conversation_id: req.conversation_id,
    lead_id: req.lead_id,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    tokensCached: result.tokensCached,
  });
  const costUsd = tokenEntry.estimated_cost_usd;
  await saveTokenUsage(tokenEntry);

  const pctCache = result.tokensIn > 0 ? Math.round((result.tokensCached / result.tokensIn) * 100) : 0;
  console.log(`[Orchestrator] provider=${providerUsed} model=${result.model} tokensIn=${result.tokensIn} tokensOut=${result.tokensOut} cached=${result.tokensCached} (${pctCache}%) executorCalled=${result.executorTrace.called}`);

  let parsed = parseOrchestratorOutput(result.output, entregouAoCliente(result.executorTrace.tools_called));

  // ── Cotação no código (agents/cotacao.ts) ─────────────────────
  // Marcador {{preco|pix|datas:ITEM}} vira o texto exato do item que a busca devolveu
  // neste turno. Marcador sem item: uma reescrita com a lista do que veio; se insistir,
  // a linha sai. Nenhum "{{...}}" chega ao paciente, com a chave ligada ou não.
  if (temMarcador(parsed.mensagens)) {
    const catalogo = catalogoDoTurno(result.executorTrace.tools_called);
    const titulos = req.cotacao?.titulos ?? {};
    let cot = resolverMarcadores(parsed.mensagens, catalogo, titulos);
    let desfechoCot = 'ok';
    if (cot.naoResolvidos.length && !deadline.expired()) {
      const nomes = catalogo.map((i) => i.nome);
      const instrucao =
        `[Instrução interna, não é do cliente: estes marcadores da sua resposta não correspondem a nenhum item que a busca trouxe neste turno: ${cot.naoResolvidos.join('; ')}. ` +
        (nomes.length
          ? `Itens que a busca trouxe: ${nomes.join(' | ')}. Reescreva no mesmo formato de saída usando o nome de um desses nos marcadores. `
          : 'A busca não trouxe nenhum item com valor. ') +
        'Se o que o cliente pediu não está entre eles, não cite valor nem data: diga que vai confirmar com a equipe e transfira.]';
      const revisto = await reescreverComInstrucao(req, history, estilo, providerUsed, result, instrucao, deadline);
      if (revisto && revisto.mensagens.length) {
        cot = resolverMarcadores(revisto.mensagens, catalogo, titulos);
        parsed = { ...revisto, mensagens: parsed.mensagens };
        desfechoCot = cot.naoResolvidos.length ? 'reescrita_falhou' : 'reescrito';
      } else desfechoCot = 'reescrita_falhou';
    }
    const semMarcador = cot.mensagens
      .map((m) => m.split('\n').filter((l) => !RESTO_DE_MARCADOR.test(l)).join('\n').trim())
      .filter((m) => m.length > 0);
    parsed = semMarcador.length
      ? { ...parsed, mensagens: semMarcador }
      : { mensagens: [MENSAGEM_VALOR_A_CONFIRMAR], redirect_human: true, transfer_reason: 'Cotação sem item correspondente na busca: a equipe confirma valor e datas.' };
    console.log(`[Cotacao] resolvidos=${cot.resolvidos} naoResolvidos=${cot.naoResolvidos.length} desfecho=${desfechoCot} (lead ${req.lead_id})`);
    if (desfechoCot !== 'ok') {
      await logGuardShadow({
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        verdict: `cotacao_${desfechoCot}`,
        tokens: cot.naoResolvidos,
        mensagens: parsed.mensagens,
        tools_called: result.executorTrace.tools_called.map((t) => t.tool),
        tipos_pedidos: catalogo.map((i) => i.nome).slice(0, 20),
        guard_mode: 'enforce',
      });
    }
  }

  // ── Guard de grounding (src/agents/guard.ts) ──────────────────
  // Duas checagens determinísticas, sem LLM e sem rede. Em `shadow` (padrão) só
  // grava o veredito; em `enforce` troca o texto por um pedido de tempo. O caso
  // que motivou: tarefa VENDA pedida, Executor chamou só o CRM, e o Orquestrador
  // inventou preço, horário e nome de médico (31/08/2026, lead 50404509).
  const vereditoTarefa = checarTarefaSemFerramenta(
    result.communications[0]?.query,
    result.executorTrace.tools_called,
  );
  const vereditoGrounding = checarGrounding({
    mensagens: parsed.mensagens,
    toolResults: result.communications.map((c) => c.result).join('\n'),
    clientMessage: req.client_messages,
    // NÃO é `history` inteiro: fala do agente em turno sem ferramenta de negócio
    // fica de fora, senão a alucinação de um turno vira lastro do turno seguinte.
    history: historicoConfiavel(history),
    systemPrompt: req.system_prompt,
  });

  const semLastro =
    vereditoGrounding.verdict === 'ungrounded' &&
    vereditoTarefa.verdict === 'tarefa_sem_ferramenta';

  if (vereditoGrounding.verdict !== 'ok' || vereditoTarefa.verdict !== 'ok') {
    await logGuardShadow({
      agent_id: req.agent_id,
      conversation_id: req.conversation_id,
      lead_id: req.lead_id,
      verdict: semLastro ? 'ungrounded_sem_ferramenta' : `${vereditoGrounding.verdict}|${vereditoTarefa.verdict}`,
      tokens: vereditoGrounding.tokens_sem_lastro,
      mensagens: parsed.mensagens,
      tools_called: vereditoTarefa.tools_chamadas,
      tipos_pedidos: vereditoTarefa.tipos_pedidos,
      guard_mode: config.guardMode,
    });
  }

  // Só bloqueia na interseção das duas evidências: token sem lastro NENHUM **e**
  // nenhuma ferramenta de negócio no turno. Uma sozinha gera falso positivo
  // demais (valor que mora na persona, tarefa resolvida pelo histórico).
  if (config.guardMode === 'enforce' && semLastro) {
    console.error(
      `[Guard] resposta sem lastro bloqueada — tokens=${vereditoGrounding.tokens_sem_lastro.join(',')} tipos=${vereditoTarefa.tipos_pedidos.join(',')} (lead ${req.lead_id})`,
    );
    parsed = { ...parsed, mensagens: MENSAGEM_SEM_LASTRO };
  }

  // ── Valor e data sem fonte: reescreve, e se insistir transfere ──────────
  // (guard.ts `checarValoresSemFonte`). Caso que motivou: preventivo cotado a
  // R$ 100 com datas que a busca não trouxe (13/10/2026). Valor errado chega ao
  // paciente e vira cobrança na recepção; transferir é melhor que isso.
  if (config.lastroMode !== 'off' && parsed.mensagens.length) {
    let fontes = [
      ...result.communications.map((c) => c.result),
      JSON.stringify(result.executorTrace.tools_called.map((t) => t.result)),
    ].join('\n');
    const baseLastro = {
      toolResults: fontes,
      clientMessage: req.client_messages,
      history: historicoConfiavel(history),
      systemPrompt: req.system_prompt,
    };
    let semFonte = checarValoresSemFonte({ ...baseLastro, mensagens: parsed.mensagens });
    // Só lê o banco quando a primeira checagem acusou algo: turno normal não paga a consulta.
    if (semFonte.length) {
      fontes += '\n' + (await textosEnviadosPorFora(req.conversation_id, history));
      baseLastro.toolResults = fontes;
      semFonte = checarValoresSemFonte({ ...baseLastro, mensagens: parsed.mensagens });
    }
    if (semFonte.length) {
      const lista = semFonte.map((v) => v.texto);
      let desfecho: 'shadow' | 'reescrito' | 'transferido' = 'shadow';
      const mensagensOriginais = parsed.mensagens;
      if (config.lastroMode === 'enforce') {
        const revisto = deadline.expired()
          ? null
          : await reescreverSemValorInventado(req, history, estilo, providerUsed, result, lista, fontes, deadline);
        const restou = revisto ? checarValoresSemFonte({ ...baseLastro, mensagens: revisto.mensagens }) : semFonte;
        if (revisto && revisto.mensagens.length && restou.length === 0) {
          parsed = revisto;
          desfecho = 'reescrito';
        } else {
          parsed = {
            mensagens: [MENSAGEM_VALOR_A_CONFIRMAR],
            redirect_human: true,
            transfer_reason: `Valor ou data sem confirmação no sistema (${lista.join(', ')}): a equipe confirma com o paciente.`,
          };
          desfecho = 'transferido';
        }
      }
      console.warn(`[Lastro] ${desfecho}: ${lista.join(', ')} (lead ${req.lead_id})`);
      await logGuardShadow({
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        verdict: `valor_sem_fonte_${desfecho}`,
        tokens: semFonte.map((v) => v.canonico),
        mensagens: desfecho === 'shadow' ? mensagensOriginais : [...mensagensOriginais, '--- enviado ---', ...parsed.mensagens],
        tools_called: result.executorTrace.tools_called.map((t) => t.tool),
        tipos_pedidos: semFonte.map((v) => v.tipo),
        guard_mode: config.lastroMode,
      });
    }
  }

  // Passada final da cotação: a reescrita do guard de lastro (acima) também recebe a
  // instrução dos marcadores e pode devolver {{...}}. Resolve com o mesmo catálogo e
  // tira a linha que sobrar com marcador; sem texto nenhum, transfere.
  if (temMarcador(parsed.mensagens)) {
    const r = resolverMarcadores(parsed.mensagens, catalogoDoTurno(result.executorTrace.tools_called), req.cotacao?.titulos ?? {});
    const limpas = r.mensagens
      .map((m) => m.split('\n').filter((l) => !RESTO_DE_MARCADOR.test(l)).join('\n').trim())
      .filter((m) => m.length > 0);
    parsed = limpas.length
      ? { ...parsed, mensagens: limpas }
      : { mensagens: [MENSAGEM_VALOR_A_CONFIRMAR], redirect_human: true, transfer_reason: 'Cotação sem item correspondente na busca: a equipe confirma valor e datas.' };
  }

  // Guard de agendamento: a resposta não pode afirmar que o horário está marcado
  // sem que o evento exista. Só toca a rede quando o texto casa o padrão de
  // confirmação — nos demais turnos o custo é uma regex.
  if (afirmaAgendamento(parsed.mensagens)) {
    const [intentsOuNull, jaTemCompromisso, logsDaConversa] = await Promise.all([
      getAgentIntents(req.agent_id),
      conversaTemCompromissoCriado(req.agent_id, req.conversation_id),
      getIntentLogsCompletos(req.agent_id, req.conversation_id),
    ]);

    if (intentsOuNull === null) {
      // `null` = a LEITURA falhou (erro do Supabase), diferente de "agente sem
      // agenda" ([]). Antes, os dois casos viravam [] e o guard tomava a MESMA
      // decisão ({acao:'nada'}) — reabrindo o bug que o commit afaff0c fechou
      // (confirmar agendamento sem criar evento) toda vez que a leitura
      // falhasse de forma transitória. Fail-open no resultado final (a resposta
      // do cliente segue intacta, igual ao guard normal), mas com log explícito
      // — quem investigar não pode confundir "não sei se tem agenda" com "não
      // tem agenda".
      console.error(`[Orchestrator] getAgentIntents falhou (erro de leitura) — guard de agendamento pulado neste turno (agent_id=${req.agent_id}, conversation_id=${req.conversation_id})`);
    } else {
      const veredito = await garantirAgendamento({
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        intents: intentsOuNull,
        jaTemCompromisso,
        logsDaConversa,
        toolsDoTurno: result.executorTrace.tools_called,
        mensagens: parsed.mensagens,
      });

      if (veredito.acao === 'detectado') {
        // Fantasma visto num agente cujo reparo não é suportado (Duda, Carol):
        // a resposta segue intacta e o sinal vira linha auditável.
        await logGuardShadow({
          agent_id: req.agent_id,
          conversation_id: req.conversation_id,
          lead_id: req.lead_id,
          verdict: 'agendamento_sem_intent',
          tokens: veredito.iso ? [veredito.iso] : [],
          mensagens: parsed.mensagens,
          tools_called: result.executorTrace.tools_called.map((t) => t.tool),
          tipos_pedidos: [veredito.slug],
          guard_mode: config.guardMode,
        });
      }

      if (veredito.acao === 'reoferta') {
        // Troca só o texto. `redirect_human`/`transfer_reason` são preservados:
        // se o mesmo turno também pedia transferência, o guard não pode cancelá-la.
        parsed = { ...parsed, mensagens: veredito.mensagens };
      }
      // 'reparado': o evento passou a existir, a confirmação original vale.
      // 'nada': caminho feliz — o evento já estava criado.
    }
  }

  // ── Uma resposta por rajada (agents/rajada.ts) ────────────────
  // Chegou fala nova do cliente durante o turno: o turno dela vem logo atrás e
  // responde tudo junto. Este não entrega nada e não grava a resposta como dita.
  const toolsDoTurno = result.executorTrace.tools_called.map((t) => t.tool);
  const rajada = config.rajadaMode === 'off' || !ehConversaReal(req.conversation_id)
    ? null
    : await avaliarRajada(req, { inicio, vez, tools: toolsDoTurno, redirect: parsed.redirect_human, descartesAnteriores });
  const turnoBase = { esperou_fila_ms: vez.esperouMs, cruzamento, nota_cruzamento: nota, ...(juntouPendente ? { juntou_pendente: true } : {}) };
  const rajadaLog = rajada ? { ...rajada, modo: config.rajadaMode } : undefined;

  if (rajada && (rajada.acao === 'descartar' || rajada.humano_no_turno > 0)) {
    console.log(`[Rajada] conversation=${req.conversation_id} acao=${rajada.acao} motivo=${rajada.motivo} novas=${rajada.novas} humano_no_turno=${rajada.humano_no_turno} modo=${config.rajadaMode} tools=${toolsDoTurno.join(',') || '-'} elapsed=${Date.now() - inicio}ms`);
  }

  if (rajada?.acao === 'descartar' && config.rajadaMode === 'descartar') {
    let pode = true;
    if (rajada.motivo === 'mensagem_nova') {
      // Sem o pendente gravado o texto deste turno se perderia: aí responde normal.
      pode = await setPendente(scopedClientId, {
        texto: req.client_messages,
        tipo: req.client_message_type ?? 'text',
        em: Date.now(),
        descartes: descartesAnteriores + 1,
      });
    } else {
      // Atendente assumiu: guarda a fala do cliente, não a resposta que não vai sair.
      await appendHistory(scopedClientId, [
        { role: 'user', content: historyPrefix(req.client_message_type) + req.client_messages },
      ]);
    }
    if (pode) {
      return {
        mensagens: [],
        redirect_human: false,
        logs: {
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
          turno: { ...turnoBase, descartado: true, rajada: rajadaLog },
          communication: result.communications.length > 0 ? result.communications : undefined,
        },
      };
    }
    console.error(`[Rajada] conversation=${req.conversation_id} pendente não gravado, turno responde normal`);
  }

  // Mídia no fluxo (agents/midia-no-fluxo.ts): fotos que o `enviar_arquivo` deixou
  // para a resposta entram antes da última mensagem; o n8n manda tudo em ordem.
  const midias = midiasAdiadas(result.executorTrace.tools_called);
  // Foto do imóvel da busca que a ficha apresentou e o modelo esqueceu de pedir (16/10, Canda).
  if (await getMidiaNoFluxo(req.agent_id)) {
    const esquecidas = fotosDaBuscaEsquecidas(result.executorTrace.tools_called, parsed.mensagens, midias);
    if (esquecidas.length > 0) {
      console.log(`[Mídia] conversation=${req.conversation_id} ${esquecidas.length} foto(s) da busca que o modelo não pediu`);
      midias.push(...esquecidas);
    }
  }
  if (midias.length > 0) {
    parsed = { ...parsed, mensagens: intercalarMidias(parsed.mensagens, midias) };
  }

  // Atualiza histórico Redis — salva o texto limpo das mensagens, não o JSON bruto.
  // Isso evita que o modelo veja JSON estrutural no histórico em vez de linguagem natural.
  const assistantContent = paraHistorico(parsed.mensagens);
  const toolsUsed = result.executorTrace.called ? toolsDoTurno : undefined;
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
    turno: { ...turnoBase, ...(rajadaLog ? { rajada: rajadaLog } : {}) },
    communication: result.communications.length > 0 ? result.communications : undefined,
  };

  return { ...parsed, logs };
}
