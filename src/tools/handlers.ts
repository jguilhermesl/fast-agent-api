import axios from 'axios';
import OpenAI from 'openai';
import { config } from '../config';
import { searchKnowledgeBase, getKbOpcoes } from '../services/supabase';
import { capTimeout } from '../services/deadline';
import { wrap, wrapError } from './envelope';
import type { ExecutorInput } from '../types';

// Todo handler devolve o envelope de `envelope.ts`. O modelo lê `status` antes de
// `data`, então "não achei" e "falhou" deixam de ser indistinguíveis de "achei".
const ORCAMENTO_ESGOTADO = { message: 'orçamento de tempo do turno esgotado', code: 'DEADLINE_EXCEEDED' };

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// ── executar_intent ───────────────────────────────────────────

export async function handleExecutarIntent(
  args: { intent_key: string; arguments: Record<string, unknown> },
  ctx: Pick<ExecutorInput, 'agent_id' | 'conversation_id' | 'deadline'>
): Promise<string> {
  // Orçamento do turno (services/deadline.ts) já estourou: aborta ANTES da
  // chamada de rede. Este é o handler com o maior teto (120s) — o que mais
  // sozinho consegue esgotar o orçamento inteiro do request.
  if (ctx.deadline?.expired()) {
    console.warn(`[Tool] executar_intent "${args.intent_key}" abortado — orçamento do turno esgotado`);
    return wrapError({ message: ORCAMENTO_ESGOTADO.message, code: ORCAMENTO_ESGOTADO.code }, { intent_key: args.intent_key, ...args.arguments });
  }
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
        timeout: capTimeout(120_000, ctx.deadline),
      }
    );
    return wrap(response.data, { intent_key: args.intent_key, ...args.arguments }, response.status);
  } catch (err: unknown) {
    // `err.message` de um 4xx é só "Request failed with status code 400". O motivo
    // está em `err.response.data`, que antes ia para o chão — era aqui que os HTTP
    // 400 do intent-dispatcher morriam e viravam "informação não disponível".
    const st = axios.isAxiosError(err) ? err.response?.status : undefined;
    const body = axios.isAxiosError(err) ? err.response?.data : undefined;
    console.error(
      `[Tool] executar_intent "${args.intent_key}" HTTP ${st ?? 'n/a'}:`,
      JSON.stringify(body ?? (err instanceof Error ? err.message : String(err))).slice(0, 500),
    );
    return wrapError(err, { intent_key: args.intent_key, ...args.arguments });
  }
}

// ── atualizar_lead_crm ────────────────────────────────────────

export async function handleAtualizarLeadCRM(
  args: { stage: string },
  ctx: Pick<ExecutorInput, 'agent_id' | 'lead_id' | 'deadline'>
): Promise<string> {
  if (ctx.deadline?.expired()) {
    console.warn('[Tool] atualizar_lead_crm abortado — orçamento do turno esgotado');
    return wrapError(ORCAMENTO_ESGOTADO, { stage: args.stage });
  }
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
        timeout: capTimeout(10_000, ctx.deadline),
      }
    );
    return wrap(response.data ?? { success: true }, { stage: args.stage }, response.status);
  } catch (err: unknown) {
    const st = axios.isAxiosError(err) ? err.response?.status : undefined;
    const body = axios.isAxiosError(err) ? err.response?.data : undefined;
    console.error(
      `[Tool] atualizar_lead_crm HTTP ${st ?? 'n/a'}:`,
      JSON.stringify(body ?? (err instanceof Error ? err.message : String(err))).slice(0, 500),
    );
    return wrapError(err, { stage: args.stage });
  }
}

// ── enviar_arquivo ────────────────────────────────────────────

/**
 * Deduz o `type` que `/api/send-external` espera a partir da extensão do
 * arquivo. `enviar_arquivo` só recebe `file_url` — não tem esse dado pronto.
 */
function tipoPorExtensao(fileUrl: string): 'image' | 'video' | 'audio' | 'document' {
  const semQuery = fileUrl.split('?')[0].toLowerCase();
  const ext = semQuery.slice(semQuery.lastIndexOf('.') + 1);
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'document';
}

export async function handleEnviarArquivo(
  args: { file_url: string },
  ctx: Pick<ExecutorInput, 'agent_id' | 'conversation_id' | 'contact_phone' | 'deadline'>
): Promise<string> {
  if (ctx.deadline?.expired()) {
    console.warn('[Tool] enviar_arquivo abortado — orçamento do turno esgotado');
    return wrapError(ORCAMENTO_ESGOTADO, { file_url: args.file_url });
  }
  try {
    // `enviar_arquivo` apontava para a Supabase Function `send-media`,
    // congelada desde 03/03/2026 (código da era Chatwoot, apagado do repo,
    // nunca redeployado — consulta `agents.chatwoot_inbox_id`, coluna que não
    // existe mais). Falhava sempre: Duda e Diana, 30+ tentativas em 2 meses.
    // `/api/send-external` é a rota que já manda mídia de verdade hoje (mesma
    // que o `messaging-gateway` do chat-flow-pilot-63 chama pro canal
    // WhatsBizAPI) — roda neste mesmo processo, então é loopback, não um
    // serviço novo.
    const response = await axios.post(
      `http://localhost:${config.port}/api/send-external`,
      {
        agent_id: ctx.agent_id,
        phone: ctx.contact_phone,
        type: tipoPorExtensao(args.file_url),
        media_url: args.file_url,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiSecret}`,
          'Content-Type': 'application/json',
        },
        timeout: capTimeout(15_000, ctx.deadline),
      }
    );
    return wrap(response.data ?? { success: true }, { file_url: args.file_url }, response.status);
  } catch (err: unknown) {
    const st = axios.isAxiosError(err) ? err.response?.status : undefined;
    const body = axios.isAxiosError(err) ? err.response?.data : undefined;
    console.error(
      `[Tool] enviar_arquivo HTTP ${st ?? 'n/a'}:`,
      JSON.stringify(body ?? (err instanceof Error ? err.message : String(err))).slice(0, 500),
    );
    return wrapError(err, { file_url: args.file_url });
  }
}

// ── agent_knowledge_base ──────────────────────────────────────

export async function handleKnowledgeBase(
  args: { query: string },
  ctx: Pick<ExecutorInput, 'agent_id' | 'deadline'>
): Promise<string> {
  if (ctx.deadline?.expired()) {
    console.warn('[Tool] agent_knowledge_base abortado — orçamento do turno esgotado');
    return wrapError(ORCAMENTO_ESGOTADO, { query: args.query });
  }
  try {
    // Gera embedding da query
    const embeddingResponse = await openai.embeddings.create(
      { model: 'text-embedding-3-small', input: args.query },
      { timeout: capTimeout(30_000, ctx.deadline) }
    );
    const embedding = embeddingResponse.data[0].embedding;

    // Busca no Supabase Vector Store
    const result = await searchKnowledgeBase(ctx.agent_id, embedding, undefined, await getKbOpcoes(ctx.agent_id));
    // A KB devolve TEXTO, não JSON: as duas frases abaixo são o "não achei" dela.
    // Sem traduzir para status='empty', o modelo lia a frase como conteúdo.
    const vazio =
      result.startsWith('(nenhuma informação relevante') ||
      result.startsWith('(base de conhecimento indisponível');
    return wrap(vazio ? [] : result, { query: args.query });
  } catch (err: unknown) {
    console.error(
      '[Tool] agent_knowledge_base error:',
      err instanceof Error ? err.message : String(err),
    );
    return wrapError(err, { query: args.query });
  }
}
