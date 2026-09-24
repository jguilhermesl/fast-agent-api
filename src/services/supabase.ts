import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import type { AgentIntent, IntentLog, TokenLogEntry } from '../types';
import type { MensagemDoCliente } from '../agents/cruzamento';

// Cliente service_role para operações privilegiadas
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

// ── Intents ──────────────────────────────────────────────────

/**
 * Intents configuradas do agente.
 *
 * Devolve `null` quando a LEITURA falhou (erro do Supabase) e `[]` quando o
 * agente de fato não tem nenhuma intent cadastrada — são coisas diferentes pra
 * quem decide em cima do resultado. O `agendamento-guard` (via orchestrator.ts)
 * usa "agente sem intent de criação" pra concluir "não é agenda, nada a fazer"
 * (`{acao:'nada'}`); antes, um erro TRANSITÓRIO de rede virava `[]` e o guard
 * tomava a MESMA decisão que tomaria pra um agente sem agenda de verdade —
 * reabrindo exatamente o bug que o commit afaff0c fechou (confirmar
 * agendamento sem criar o evento). Cada chamador decide como reagir a `null`;
 * nenhum é obrigado a travar o turno do cliente por isso (o comportamento
 * final continua fail-open — só o log deixa de mentir sobre o motivo).
 */
export async function getAgentIntents(agentId: string): Promise<AgentIntent[] | null> {
  const { data, error } = await supabase
    .from('agent_intents')
    .select('id, slug, trigger_description, request_schema')
    .eq('agent_id', agentId)
    // Intenção desligada no painel não pode virar ferramenta do Executor: antes ela
    // chegava como tool e o gatilho precisava pedir "NAO USE" (Duda: mamografia com
    // slug errado e proctologista, as duas com 404 no n8n).
    .eq('status', 'active');

  if (error) {
    console.error('[Supabase] getAgentIntents error:', error.message);
    return null;
  }
  return data ?? [];
}

// ── Intent execution logs (contexto) ─────────────────────────

export async function getIntentLogs(
  agentId: string,
  conversationId: string
): Promise<IntentLog[]> {
  const { data, error } = await supabase
    .from('intent_execution_logs')
    .select('id, intent_key, arguments, response_data, success, created_at')
    .eq('agent_id', agentId)
    .eq('conversation_id', conversationId)
    .eq('needs_context', true)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[Supabase] getIntentLogs error:', error.message);
    return [];
  }
  return (data ?? []).reverse();
}

/**
 * A conversa já tem um compromisso criado com sucesso?
 *
 * Query própria, sem janela de tempo e sem `limit` que possa cortar: uma conversa
 * da Duda medida em 14/08/2026 remetia a um agendamento feito 14 dias antes, e
 * qualquer corte por recência faria o guard concluir que não existia evento e
 * criar um segundo.
 *
 * Também não filtra `needs_context` — `realizar_agendamento` grava com `false` e
 * ficaria invisível.
 */
export async function conversaTemCompromissoCriado(
  agentId: string,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('intent_execution_logs')
    .select('id')
    .eq('agent_id', agentId)
    .eq('conversation_id', conversationId)
    .eq('success', true)
    .or('intent_key.ilike.%criar_evento%,intent_key.ilike.%create_event%,intent_key.ilike.%realizar_agendament%,intent_key.ilike.%agendar_%')
    .limit(1);

  if (error) {
    // Na dúvida, assume que existe: preferimos não agir a criar evento duplicado.
    console.error('[Supabase] conversaTemCompromissoCriado error:', error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

/**
 * Últimos logs da conversa — usados só para remontar os horários que a agenda
 * ofereceu, quando o guard precisa reofertar.
 */
export async function getIntentLogsCompletos(
  agentId: string,
  conversationId: string
): Promise<IntentLog[]> {
  const { data, error } = await supabase
    .from('intent_execution_logs')
    .select('id, intent_key, arguments, response_data, success, created_at')
    .eq('agent_id', agentId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    console.error('[Supabase] getIntentLogsCompletos error:', error.message);
    return [];
  }
  return (data ?? []).reverse();
}

// ── Falas do cliente (detecção de cruzamento) ─────────────────

/**
 * Mensagens do cliente (inbound) da conversa com `created_at` no intervalo.
 * Usada só por agents/cruzamento.ts, e só quando o turno anterior terminou há
 * até 45 s. Anda no índice `idx_messages_conv_created`. Erro vira
 * exceção: quem chama trata como "sem cruzamento" (fail-open).
 */
export async function getMensagensDoCliente(
  conversationId: string,
  desdeIso: string,
  ateIso: string
): Promise<MensagemDoCliente[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at, message_type, content')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .gte('created_at', desdeIso)
    .lte('created_at', ateIso)
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) throw new Error(`getMensagensDoCliente: ${error.message}`);
  return data ?? [];
}

// ── Token tracking ────────────────────────────────────────────

export async function saveTokenUsage(entry: TokenLogEntry): Promise<void> {
  const { error } = await supabase
    .from('llm_usage_logs')
    .insert(entry);

  if (error) {
    console.error('[Supabase] saveTokenUsage error:', error.message);
  }
}

// Tarifa e custo moram em ./pricing — aritmética pura, testável sem env nem rede.
// Reexportados aqui para não quebrar quem já importava daqui.
export { calcCostUsd, inferModelProvider, buildTokenLogEntry, CURRENT_PRICING_VERSION } from './pricing';

// ── Error logging ─────────────────────────────────────────────

export async function logError(params: {
  conversation_id: string;
  agent_id: string;
  lead_id: string;
  error_message: string;
  provider_failed: string;
  layer: string;
}): Promise<void> {
  const { error } = await supabase
    .from('agent_error_logs')
    .insert(params);

  if (error) {
    console.error('[Supabase] logError error:', error.message);
  }
}

// ── Guard de grounding: log em shadow ─────────────────────────
// Nunca pode derrubar a resposta do cliente: qualquer erro aqui só vira console.
// A tabela nasce com retenção de 14 dias (migration 20260901210000) — o banco é
// Micro e já caiu inteiro por tabela de log sem poda.

export async function logGuardShadow(params: {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  verdict: string;
  tokens: string[];
  mensagens: string[];
  tools_called: string[];
  tipos_pedidos?: string[];
  guard_mode: string;
}): Promise<void> {
  try {
    const { error } = await supabase.from('guard_shadow_logs').insert(params);
    if (error) console.error('[Supabase] logGuardShadow error:', error.message);
  } catch (err: unknown) {
    console.error('[Supabase] logGuardShadow throw:', err instanceof Error ? err.message : String(err));
  }
}

// ── Send-external: conversation context ───────────────────────

export interface ConversationContext {
  id: string;
  agent_id: string;
  last_message_at: string | null;
  channel: {
    provider: string;
    credentials: Record<string, string>;
  };
  contact: {
    phone: string;
  } | null;
}

export async function getConversationContext(
  conversationId: string,
): Promise<ConversationContext | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, agent_id, last_message_at, channel:channels(provider, credentials), contact:contacts(phone)')
    .eq('id', conversationId)
    .single();

  if (error || !data) {
    console.error('[Supabase] getConversationContext error:', error?.message);
    return null;
  }

  const raw = data as unknown as {
    id: string;
    agent_id: string;
    last_message_at: string | null;
    channel: { provider: string; credentials: Record<string, string> } | null;
    contact: { phone: string } | null;
  };

  if (!raw.channel) return null;

  return {
    id: raw.id,
    agent_id: raw.agent_id,
    last_message_at: raw.last_message_at,
    channel: raw.channel,
    contact: raw.contact,
  };
}

/**
 * Lookup channel credentials by agent_id alone (no conversation needed).
 * Used when sending a first-contact message with no existing lead.
 */
export async function getChannelByAgentId(
  agentId: string,
): Promise<{ provider: string; credentials: Record<string, string> } | null> {
  const { data, error } = await supabase
    .from('channels')
    .select('provider, credentials')
    .eq('agent_id', agentId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error('[Supabase] getChannelByAgentId error:', error?.message);
    return null;
  }

  return data as { provider: string; credentials: Record<string, string> };
}

/**
 * Alternative lookup: find a conversation by agent_id + contact phone.
 * Returns the most recent lead that matches.
 */
export async function getConversationContextByPhone(
  agentId: string,
  phone: string,
): Promise<ConversationContext | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, agent_id, last_message_at, channel:channels!inner(provider, credentials), contact:contacts!inner(phone)')
    .eq('agent_id', agentId)
    .eq('contacts.phone', phone)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] getConversationContextByPhone error:', error.message);
    return null;
  }
  if (!data) return null;

  const raw = data as unknown as {
    id: string;
    agent_id: string;
    last_message_at: string | null;
    channel: { provider: string; credentials: Record<string, string> } | null;
    contact: { phone: string } | null;
  };

  if (!raw.channel) return null;

  return {
    id: raw.id,
    agent_id: raw.agent_id,
    last_message_at: raw.last_message_at,
    channel: raw.channel,
    contact: raw.contact,
  };
}

// ── Send-external: message persistence ────────────────────────

export interface MessageAttachment {
  url: string;
  type: string;
  mimetype: string;
}

export interface InsertMessageParams {
  conversation_id: string;
  content: string;
  direction: 'outbound' | 'inbound';
  message_type: string;
  attachments: MessageAttachment[];
  status: 'sending' | 'sent' | 'failed' | 'queued';
}

export async function insertMessage(
  params: InsertMessageParams,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('messages')
    .insert(params)
    .select('id')
    .single();

  if (error) {
    console.error('[Supabase] insertMessage error:', error.message);
    return null;
  }

  return data as { id: string };
}

export async function updateMessageStatus(
  messageId: string,
  update: { status: 'sent' | 'failed'; provider_message_id?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .update(update)
    .eq('id', messageId);

  if (error) {
    console.error('[Supabase] updateMessageStatus error:', error.message);
  }
}

export async function updateLeadLastMessageAt(
  conversationId: string,
  timestamp: string,
): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ last_message_at: timestamp })
    .eq('id', conversationId);

  if (error) {
    console.error('[Supabase] updateLeadLastMessageAt error:', error.message);
  }
}

// ── Knowledge base (vector search) ───────────────────────────

const KB_MATCH_COUNT   = 3;    // máximo de chunks retornados
// `match_documents` devolve `1 - (embedding <=> query)`, e `<=>` é DISTÂNCIA DE
// COSSENO no pgvector — logo `similarity` é o cosseno puro, teto 1,0. O valor
// anterior aqui era 1.30, apoiado num comentário que dizia "similarity = 1 + cosseno,
// faixa 0-2". Isso era verdade quando a função usava `<#>` (produto interno negativo,
// similarity = 1 + cosseno, faixa 0-2) — leitura registrada em 25/08/2026. Em algum
// ponto entre 25/08 e 28/08 a função passou a usar `<=>`, aplicada direto no banco,
// fora de migration: a migration `20260828170000_versiona_match_documents` é uma
// transcrição do que já rodava, não a mudança. Desde essa troca, e sem qualquer
// aviso, o filtro descarta 100% dos chunks nos 12 agentes: a base responde
// "(nenhuma informação relevante)" em toda chamada, sem erro e sem log de falha.
// Não há trilha de quem trocou o operador nem de quando.
// Medido em 28/08/2026 contra os treinamentos da Duda: texto que responde à pergunta
// tira 0,41 a 0,53. 0.30 é o mesmo piso que a própria função SQL já aplica.
const KB_MIN_SIMILARITY = 0.30;
// Alinhado ao CHUNK_SIZE=6000 do generate-embedding (chat-flow-pilot-63): a
// ingestão agora fatia o treinamento em pedaços de até 6000 chars, cada um
// com embedding próprio. Cortar a leitura em 2000 mutilava um chunk inteiro
// no meio da frase (medido na Duda: corte no meio do preparo de exame de
// cultura). 6000 evita truncar um chunk bem formado; documento ainda maior
// que isso já vira mais de um chunk na origem.
const KB_MAX_CHUNK_CHARS = 6000;

/**
 * Ajuste da busca por agente, em `agents.prompt_config.kb`:
 *   { "min_similarity": 0.45, "excluir_injetados": true }
 * Sem a chave, vale o comportamento global de antes (0,30, tudo entra).
 *
 * Por que por agente: na Duda (24/09/2026, 341 chamadas reais) 81% das buscas
 * traziam algum Preparo sem relação com a pergunta, e a Objeções — que já vai no
 * prompt em todo turno — voltava de novo 71 vezes por semana. Nos outros agentes
 * quase todo treinamento é `always` e o Executor, que não vê o prompt, depende
 * da busca para lê-los: excluir os injetados para todos quebraria esses agentes.
 */
export interface KbOpcoes {
  minSimilarity?: number;
  /** ids de treinamentos que já entram no prompt (injection_mode ≠ ondemand) */
  excluirIds?: Set<string>;
}

const KB_OPCOES_TTL_MS = 5 * 60_000;
const kbOpcoesCache = new Map<string, { em: number; opcoes: KbOpcoes }>();

export async function getKbOpcoes(agentId: string): Promise<KbOpcoes> {
  const cache = kbOpcoesCache.get(agentId);
  if (cache && Date.now() - cache.em < KB_OPCOES_TTL_MS) return cache.opcoes;
  const opcoes: KbOpcoes = {};
  try {
    const { data: ag } = await supabase.from('agents').select('prompt_config').eq('id', agentId).single();
    const kb = (ag?.prompt_config as { kb?: { min_similarity?: unknown; excluir_injetados?: unknown } } | null)?.kb;
    if (typeof kb?.min_similarity === 'number' && kb.min_similarity > 0 && kb.min_similarity < 1) {
      opcoes.minSimilarity = kb.min_similarity;
    }
    if (kb?.excluir_injetados === true) {
      const { data: docs } = await supabase
        .from('agent_trainings')
        .select('id, injection_mode')
        .eq('agent_id', agentId)
        .eq('status', 'active');
      opcoes.excluirIds = new Set(
        (docs ?? []).filter((d: { injection_mode: string | null }) => d.injection_mode !== 'ondemand').map((d: { id: string }) => d.id),
      );
    }
  } catch (err) {
    console.error('[KB] opções do agente não lidas, vale o padrão:', err instanceof Error ? err.message : String(err));
  }
  kbOpcoesCache.set(agentId, { em: Date.now(), opcoes });
  return opcoes;
}

export async function searchKnowledgeBase(
  agentId: string,
  queryEmbedding: number[],
  limit = KB_MATCH_COUNT,
  opcoes: KbOpcoes = {},
): Promise<string> {
  const minimo = opcoes.minSimilarity ?? KB_MIN_SIMILARITY;
  const excluir = opcoes.excluirIds ?? new Set<string>();
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    filter: { agent_id: agentId },
    // pede a mais o que pode ser excluído, para os `limit` que sobram serem os melhores
    match_count: limit + excluir.size,
  });

  if (error) {
    console.error('[Supabase] searchKnowledgeBase error:', error.message);
    return '(base de conhecimento indisponível no momento)';
  }

  const docs = (data ?? []) as Array<{ id?: string; content: string; similarity: number; metadata?: Record<string, unknown> }>;

  // Log para debug — mostra scores e metadados de cada chunk retornado
  console.log(`[KB] query retornou ${docs.length} chunks para agent_id=${agentId}:`);
  docs.forEach((d, i) => {
    const preview = d.content.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  [${i + 1}] similarity=${d.similarity.toFixed(4)} | metadata=${JSON.stringify(d.metadata ?? {})} | "${preview}..."`);
  });

  // Filtra por similaridade mínima e tira o que já está no prompt do agente
  const relevant = docs
    .filter((d) => d.similarity >= minimo && !(d.id && excluir.has(d.id)))
    .slice(0, limit);

  console.log(`[KB] após filtro (>=${minimo}${excluir.size ? `, sem ${excluir.size} injetado(s)` : ''}): ${relevant.length} chunks aprovados`);

  if (relevant.length === 0) {
    return '(nenhuma informação relevante encontrada na base de conhecimento)';
  }

  return relevant
    .map((doc) => {
      const text = doc.content.trim();
      // Trunca chunks muito longos mantendo frases completas
      if (text.length <= KB_MAX_CHUNK_CHARS) return text;
      const truncated = text.slice(0, KB_MAX_CHUNK_CHARS);
      const lastPeriod = truncated.lastIndexOf('.');
      return lastPeriod > KB_MAX_CHUNK_CHARS * 0.6
        ? truncated.slice(0, lastPeriod + 1)
        : truncated + '...';
    })
    .join('\n\n---\n\n');
}
