import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import type { AgentIntent, IntentLog, TokenLogEntry } from '../types';

// Cliente service_role para operações privilegiadas
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);

// ── Intents ──────────────────────────────────────────────────

export async function getAgentIntents(agentId: string): Promise<AgentIntent[]> {
  const { data, error } = await supabase
    .from('agent_intents')
    .select('id, slug, trigger_description, request_schema')
    .eq('agent_id', agentId);

  if (error) {
    console.error('[Supabase] getAgentIntents error:', error.message);
    return [];
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

// ── Token tracking ────────────────────────────────────────────

export async function saveTokenUsage(entry: TokenLogEntry): Promise<void> {
  const { error } = await supabase
    .from('llm_usage_logs')
    .insert(entry);

  if (error) {
    console.error('[Supabase] saveTokenUsage error:', error.message);
  }
}

export function inferModelProvider(modelName: string): string {
  if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3')) return 'openai';
  if (modelName.startsWith('claude')) return 'anthropic';
  if (modelName.startsWith('gemini')) return 'gemini';
  return 'unknown';
}

// Tokens servidos do cache de prompt custam uma fração do input normal. A OpenAI
// devolve quantos foram em usage.prompt_tokens_details.cached_tokens, e esse valor
// JÁ ESTÁ somado em prompt_tokens — cobrar tudo a preço cheio infla o custo relatado.
// Fonte do fator: openai.com/api/pricing (cached input a 10% do input).
const CACHED_INPUT_FACTOR = 0.1;

// Modelos sem entrada própria na tabela, avisados uma vez cada — repetir a cada
// chamada afogaria o log.
const modelosSemPreco = new Set<string>();

/**
 * Preço do modelo: match exato, senão o prefixo MAIS LONGO que casar.
 *
 * O comprimento importa. `Object.entries(...).find()` devolvia o primeiro prefixo
 * na ordem de declaração, e "gpt-4.1" vem antes de "gpt-4.1-mini" — então
 * `gpt-4.1-mini-2025-04-14` era cobrado a US$ 2,00/1M em vez de US$ 0,40/1M, 5×
 * mais caro. O mesmo acontecia com gpt-4.1-nano e gpt-4o-mini.
 */
function ratesFor(model: string): { input: number; output: number } {
  const exato = config.tokenCost[model];
  if (exato) return exato;

  const candidatos = Object.entries(config.tokenCost)
    .filter(([key]) => model.startsWith(key))
    .sort((a, b) => b[0].length - a[0].length);

  if (!candidatos.length) {
    if (!modelosSemPreco.has(model)) {
      modelosSemPreco.add(model);
      console.warn(`[Custo] modelo "${model}" não está em config.tokenCost — usando tarifa genérica.`);
    }
    return { input: 0.000001, output: 0.000003 };
  }

  const [key, rates] = candidatos[0];

  // O prefixo casou, mas perdeu o tier: "gpt-5.4-mini-2026-03-17" casa "gpt-5.4"
  // e passa a ser cobrado como o modelo grande. Não dá para adivinhar a tarifa do
  // mini, então mantém o valor e grita — o custo relatado desse modelo fica
  // inflado até alguém cadastrar o preço certo. Medido em 30 dias de
  // `llm_usage_logs`: 99.491.846 tokens de input do executor contabilizados a
  // US$ 2,50/1M, US$ 287,90 no período.
  const tier = model.match(/-(mini|nano)\b/)?.[1];
  if (tier && !key.includes(tier) && !modelosSemPreco.has(model)) {
    modelosSemPreco.add(model);
    console.warn(`[Custo] "${model}" está sendo cobrado com a tarifa de "${key}" — falta entrada "${key}-${tier}" em config.tokenCost. O custo relatado deste modelo está INFLADO.`);
  }

  return rates;
}

export function calcCostUsd(model: string, tokensIn: number, tokensOut: number, cachedIn = 0): number {
  const rates = ratesFor(model);

  const cached = Math.min(Math.max(cachedIn, 0), tokensIn);
  const fresh  = tokensIn - cached;

  return parseFloat(
    ((fresh * rates.input) + (cached * rates.input * CACHED_INPUT_FACTOR) + (tokensOut * rates.output)).toFixed(8)
  );
}

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
const KB_MIN_SIMILARITY = 1.30; // descarta resultados pouco relevantes (similarity > 1 = distância, não cosine)
const KB_MAX_CHUNK_CHARS = 2000; // trunca chunks muito longos (aumentado de 600 para 2000)

export async function searchKnowledgeBase(
  agentId: string,
  queryEmbedding: number[],
  limit = KB_MATCH_COUNT,
): Promise<string> {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    filter: { agent_id: agentId },
    match_count: limit,
  });

  if (error) {
    console.error('[Supabase] searchKnowledgeBase error:', error.message);
    return '(base de conhecimento indisponível no momento)';
  }

  const docs = (data ?? []) as Array<{ content: string; similarity: number; metadata?: Record<string, unknown> }>;

  // Log para debug — mostra scores e metadados de cada chunk retornado
  console.log(`[KB] query retornou ${docs.length} chunks para agent_id=${agentId}:`);
  docs.forEach((d, i) => {
    const preview = d.content.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  [${i + 1}] similarity=${d.similarity.toFixed(4)} | metadata=${JSON.stringify(d.metadata ?? {})} | "${preview}..."`);
  });

  // Filtra por similaridade mínima para evitar ruído fora de contexto
  const relevant = docs.filter((d) => d.similarity >= KB_MIN_SIMILARITY);

  console.log(`[KB] após filtro (>=${KB_MIN_SIMILARITY}): ${relevant.length} chunks aprovados`);

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
