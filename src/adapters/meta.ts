import axios from 'axios';
import type { AdapterResult, SendMessageParams } from './messaging';

// ── Meta Cloud API (app próprio da Fast IA, Tech Provider) ─────
//
// Número do cliente conectado pelo Embedded Signup no app da Fast IA: a entrada chega no
// messaging-gateway (rota /meta-webhook) e a saída sai daqui, direto na Graph API:
// POST /{phone_number_id}/messages.
//
// - O canal guarda só `phone_number_id` e `waba_id` em `channels.credentials`, que é legível por
//   usuário do tenant (policy "Tenant users can view their channels"). O token de negócio do
//   cliente mora em `channel_secrets` (RLS sem policy: só service role lê).
// - Fora da janela de 24h a Meta recusa texto livre (131047): só modelo aprovado passa.
// - Devolve o `wamid`, que volta nos status do webhook e casa com `messages.provider_message_id`.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';

export type TokenLookup = (phoneNumberId: string) => Promise<string | null>;

// Token por phone_number_id, com cache curto: o adapter roda a cada mensagem da IA.
const cache = new Map<string, { token: string; ate: number }>();
const CACHE_MS = 5 * 60 * 1000;

async function tokenDoBanco(phoneNumberId: string): Promise<string | null> {
  const hit = cache.get(phoneNumberId);
  if (hit && hit.ate > Date.now()) return hit.token;
  const { supabase } = await import('../services/supabase');
  const { data, error } = await supabase
    .from('channel_secrets')
    .select('meta_access_token')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (error) {
    console.error('[Meta] leitura de channel_secrets falhou:', error.message);
    return null;
  }
  const token = (data as { meta_access_token?: string } | null)?.meta_access_token || null;
  if (token) cache.set(phoneNumberId, { token, ate: Date.now() + CACHE_MS });
  return token;
}

/** Erros da Graph API que o atendente precisa entender sem abrir log. */
export function motivoMeta(code: number | undefined, mensagem: string): string {
  switch (code) {
    case 131047:
      return 'Meta: passou da janela de 24h, só modelo aprovado pode ser enviado';
    case 131026:
      return 'Meta: mensagem não entregável (número sem WhatsApp ou app desatualizado)';
    case 131042:
      return 'Meta: problema de pagamento na conta do WhatsApp do cliente';
    case 133010:
      return 'Meta: número não registrado na Cloud API';
    case 190:
      return 'Meta: token do canal inválido ou expirado (reconectar o WhatsApp)';
    case 10:
    case 200:
      return 'Meta: app sem permissão nessa conta do WhatsApp';
    default:
      return `Meta${code ? ` ${code}` : ''}: ${mensagem}`;
  }
}

export function corpoMeta(para: string, params: SendMessageParams): Record<string, unknown> | null {
  const tipo = String(params.type || 'text').toLowerCase();
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para };
  if (params.mediaUrl && tipo !== 'text') {
    const legenda = params.content ? { caption: params.content } : {};
    switch (tipo) {
      case 'audio':
      case 'ptt':
        return { ...base, type: 'audio', audio: { link: params.mediaUrl } };
      case 'video':
        return { ...base, type: 'video', video: { link: params.mediaUrl, ...legenda } };
      case 'document': {
        const nome = decodeURIComponent(params.mediaUrl.split('?')[0].split('/').pop() || '') || 'documento';
        return { ...base, type: 'document', document: { link: params.mediaUrl, filename: nome, ...legenda } };
      }
      default:
        return { ...base, type: 'image', image: { link: params.mediaUrl, ...legenda } };
    }
  }
  if (!params.content) return null;
  return { ...base, type: 'text', text: { body: params.content, preview_url: true } };
}

export async function metaSend(
  credentials: Record<string, string>,
  params: SendMessageParams,
  buscarToken: TokenLookup = tokenDoBanco,
): Promise<AdapterResult> {
  const phoneNumberId = credentials.phone_number_id;
  if (!phoneNumberId) return { success: false, error: 'Meta: canal sem phone_number_id' };
  const para = String(params.phone || '').replace(/\D/g, '');
  if (!para) return { success: false, error: 'Meta: telefone vazio' };
  const body = corpoMeta(para, params);
  if (!body) return { success: false, error: 'Meta: mensagem vazia' };

  const token = await buscarToken(phoneNumberId);
  if (!token) return { success: false, error: 'Meta: canal sem token em channel_secrets' };

  try {
    const res = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30_000 },
    );
    const id = (res.data as { messages?: { id?: string }[] } | undefined)?.messages?.[0]?.id;
    if (!id) return { success: false, error: 'Meta: resposta sem id da mensagem' };
    return { success: true, providerMessageId: id };
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      const erro = (e.response?.data as { error?: { code?: number; message?: string } } | undefined)?.error;
      const motivo = motivoMeta(erro?.code, erro?.message ?? e.message);
      console.error(`[Meta] ❌ envio falhou status=${status} pnid=${phoneNumberId} fone=${para} tipo=${String(body.type)}: ${motivo}`);
      if (erro?.code === 190) cache.delete(phoneNumberId);
      return { success: false, error: motivo };
    }
    console.error('[Meta] ❌ envio falhou:', String(e));
    return { success: false, error: String(e) };
  }
}
