import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import { config } from '../config';
import { getConversationContext } from '../services/supabase';

export const typingRouter = Router();

// ── Request validation ────────────────────────────────────────

const TypingSchema = z.object({
  conversation_id: z.string().min(1),
});

// ── Auth middleware ────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  const webhookSecret = req.headers['x-webhook-secret'] as string | undefined;

  if (token !== config.apiSecret && webhookSecret !== config.webhookSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── Dispara typing no Z-API (fire and forget) ─────────────────

async function sendZapiTyping(
  credentials: Record<string, string>,
  phone: string,
): Promise<void> {
  const instanceId = credentials.instance_id;
  const apiToken   = credentials.api_token;
  const baseUrl    = credentials.api_url || 'https://api.z-api.io';

  if (!instanceId || !apiToken) {
    console.warn('[typing] Z-API credentials missing — skipping');
    return;
  }

  const endpoint = `${baseUrl}/instances/${instanceId}/token/${apiToken}/send-chat-state`;

  try {
    await axios.post(
      endpoint,
      { phone, chatState: 'composing' },
      {
        headers: {
          'Content-Type': 'application/json',
          'Client-Token': config.zapiClientToken,
        },
        timeout: 2_000,
      },
    );
    console.log(`[typing] ✅ composing sent to ${phone}`);
  } catch (e: unknown) {
    // Falha silenciosa — typing é best-effort, não pode afetar o fluxo
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[typing] ⚠️  Z-API typing failed (ignored): ${msg}`);
  }
}

// ── POST /api/typing ──────────────────────────────────────────

typingRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parsed = TypingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  const { conversation_id } = parsed.data;

  // Responde imediatamente — não bloqueia o fluxo do n8n
  res.json({ ok: true });

  // Executa em background
  (async () => {
    const conv = await getConversationContext(conversation_id);
    if (!conv) {
      console.warn(`[typing] Conversation ${conversation_id} not found`);
      return;
    }

    // Só suporta Z-API por enquanto
    if (conv.channel.provider !== 'zapi') {
      console.log(`[typing] Provider ${conv.channel.provider} — typing not supported, skipping`);
      return;
    }

    const phone = conv.contact?.phone;
    if (!phone) {
      console.warn('[typing] No phone number found for conversation');
      return;
    }

    await sendZapiTyping(
      conv.channel.credentials as Record<string, string>,
      phone,
    );
  })().catch((e: unknown) => {
    console.error('[typing] Background error:', e instanceof Error ? e.message : String(e));
  });
});
