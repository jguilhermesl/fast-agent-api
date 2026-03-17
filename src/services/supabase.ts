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

export function calcCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  // Match exato primeiro, depois por prefixo (ex: "gpt-4.1-mini-2025-04-14" → "gpt-4.1-mini")
  const rates =
    config.tokenCost[model] ??
    Object.entries(config.tokenCost).find(([key]) => model.startsWith(key))?.[1] ??
    { input: 0.000001, output: 0.000003 };

  return parseFloat(
    ((tokensIn * rates.input) + (tokensOut * rates.output)).toFixed(8)
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
    .select('id, last_message_at, channel:channels(provider, credentials), contact:contacts(phone)')
    .eq('id', conversationId)
    .single();

  if (error || !data) {
    console.error('[Supabase] getConversationContext error:', error?.message);
    return null;
  }

  const raw = data as unknown as {
    id: string;
    last_message_at: string | null;
    channel: { provider: string; credentials: Record<string, string> } | null;
    contact: { phone: string } | null;
  };

  if (!raw.channel) return null;

  return {
    id: raw.id,
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

export async function searchKnowledgeBase(
  agentId: string,
  queryEmbedding: number[],
  limit = 5
): Promise<string> {
  const { data, error } = await supabase.rpc('match_agent_documents', {
    query_embedding: queryEmbedding,
    match_agent_id: agentId,
    match_count: limit,
  });

  if (error) {
    console.error('[Supabase] searchKnowledgeBase error:', error.message);
    return '(base de conhecimento indisponível no momento)';
  }

  if (!data || data.length === 0) {
    return '(nenhuma informação encontrada na base de conhecimento)';
  }

  return (data as Array<{ content: string; similarity: number }>)
    .map((doc) => doc.content)
    .join('\n\n---\n\n');
}
