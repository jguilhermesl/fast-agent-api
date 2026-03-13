import axios from 'axios';
import OpenAI from 'openai';
import { config } from '../config';
import { searchKnowledgeBase } from '../services/supabase';
import type { ExecutorInput } from '../types';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// ── executar_intent ───────────────────────────────────────────

export async function handleExecutarIntent(
  args: { intent_key: string; arguments: Record<string, unknown> },
  ctx: Pick<ExecutorInput, 'agent_id' | 'conversation_id'>
): Promise<string> {
  try {
    const body = {
      intent_key: args.intent_key,
      arguments: args.arguments,
      agent_id: ctx.agent_id,
      context: { conversation_id: ctx.conversation_id },
    };
    console.log(`[Tool] executar_intent "${args.intent_key}" body:`, JSON.stringify(body));
    const response = await axios.post(
      `${config.supabaseUrl}/functions/v1/intent-dispatcher`,
      body,
      {
        headers: {
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    );
    return JSON.stringify(response.data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Tool] executar_intent "${args.intent_key}" error:`, msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ── atualizar_lead_crm ────────────────────────────────────────

export async function handleAtualizarLeadCRM(
  args: { stage: string },
  ctx: Pick<ExecutorInput, 'agent_id' | 'lead_id'>
): Promise<string> {
  try {
    const response = await axios.post(
      `${config.supabaseUrl}/functions/v1/n8n-webhook`,
      {
        event_type: 'lead_status_update',
        agent_id: ctx.agent_id,
        data: {
          crm_stage: args.stage,
          lead_id: ctx.lead_id,
        },
      },
      {
        headers: {
          'x-webhook-secret': config.webhookSecret,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      }
    );
    return JSON.stringify(response.data ?? { success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Tool] atualizar_lead_crm error:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ── enviar_arquivo ────────────────────────────────────────────

export async function handleEnviarArquivo(
  args: { file_url: string },
  ctx: Pick<ExecutorInput, 'agent_id' | 'conversation_id' | 'contact_phone'>
): Promise<string> {
  try {
    const response = await axios.post(
      `${config.supabaseUrl}/functions/v1/send-media`,
      {
        agent_id: ctx.agent_id,
        contact_phone: ctx.contact_phone,
        file_url: args.file_url,
      },
      {
        headers: {
          Authorization: `Bearer ${config.supabaseServiceKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    );
    return JSON.stringify(response.data ?? { success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Tool] enviar_arquivo error:', msg);
    return JSON.stringify({ success: false, error: msg });
  }
}

// ── agent_knowledge_base ──────────────────────────────────────

export async function handleKnowledgeBase(
  args: { query: string },
  ctx: Pick<ExecutorInput, 'agent_id'>
): Promise<string> {
  try {
    // Gera embedding da query
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: args.query,
    });
    const embedding = embeddingResponse.data[0].embedding;

    // Busca no Supabase Vector Store
    const result = await searchKnowledgeBase(ctx.agent_id, embedding);
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Tool] agent_knowledge_base error:', msg);
    return '(erro ao buscar na base de conhecimento)';
  }
}
