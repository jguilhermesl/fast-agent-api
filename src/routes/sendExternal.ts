import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import {
  getConversationContext,
  getConversationContextByPhone,
  getChannelByAgentId,
  insertMessage,
  updateMessageStatus,
  updateLeadLastMessageAt,
  type MessageAttachment,
} from '../services/supabase';
import { getAdapter } from '../adapters/messaging';

export const sendExternalRouter = Router();

// ── Request validation ────────────────────────────────────────

const SendExternalSchema = z
  .object({
    conversation_id: z.string().min(1).optional(),
    agent_id:        z.string().min(1).optional(),
    phone:           z.string().optional(),
    content:         z.string().default(''),
    type:            z.string().default('text'),
    media_url:       z.string().optional(),
  })
  .refine(
    (d) => !!d.conversation_id || (!!d.agent_id && !!d.phone),
    { message: 'Provide either conversation_id OR both agent_id and phone' },
  );

// ── Auth middleware ────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  const webhookSecret = req.headers['x-webhook-secret'] as string | undefined;

  // Accept either Bearer API_SECRET or x-webhook-secret header
  if (token !== config.apiSecret && webhookSecret !== config.webhookSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── POST /api/send-external ───────────────────────────────────

sendExternalRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  // Validate body
  const parsed = SendExternalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  const { conversation_id, agent_id, phone: bodyPhone, content, type, media_url } = parsed.data;
  const isMediaType = type && type !== 'text';

  if (!content && !isMediaType) {
    res.status(400).json({ error: 'Missing content or media_url for media type' });
    return;
  }

  // ── Fetch conversation context (leads + channel + contact) ──

  let conv;
  if (conversation_id) {
    conv = await getConversationContext(conversation_id);
  } else {
    // agent_id + phone guaranteed by .refine() above
    conv = await getConversationContextByPhone(agent_id!, bodyPhone!);
  }

  // Se não encontrou conversa, tenta buscar canal pelo agent_id (primeiro contato)
  let channel: { provider: string; credentials: Record<string, string> } | null = conv?.channel ?? null;
  if (!channel) {
    if (!agent_id) {
      res.status(404).json({ error: 'Conversation not found and no agent_id provided to resolve channel' });
      return;
    }
    channel = await getChannelByAgentId(agent_id);
    if (!channel) {
      res.status(404).json({ error: 'No channel found for this agent_id' });
      return;
    }
    console.log(`[send-external] No conversation found — sending first-contact via agent_id=${agent_id}`);
  }

  const targetPhone = bodyPhone || conv?.contact?.phone;
  if (!targetPhone) {
    res.status(400).json({ error: 'No phone number available' });
    return;
  }

  // ── Build attachments array ──────────────────────────────────

  const attachments: MessageAttachment[] =
    isMediaType && media_url
      ? [
          {
            url: media_url,
            type,
            mimetype:
              type === 'video'    ? 'video/mp4'
              : type === 'audio'  ? 'audio/ogg'
              : type === 'ptt'    ? 'audio/ogg'
              : type === 'image'  ? 'image/jpeg'
              : 'application/octet-stream',
          },
        ]
      : [];

  // ── Persist message with status "sending" ───────────────────

  const resolvedConvId = conv?.id ?? null;

  // Só persiste mensagem se houver conversa vinculada
  let messageId: string | null = null;
  if (resolvedConvId) {
    const msgRow = await insertMessage({
      conversation_id: resolvedConvId,
      content: content || '',
      direction: 'outbound',
      message_type: type,
      attachments,
      status: 'sending',
    });

    if (!msgRow) {
      res.status(500).json({ error: 'Failed to persist message' });
      return;
    }

    messageId = msgRow.id;

    // Update last_message_at (fire and forget)
    const now = new Date().toISOString();
    updateLeadLastMessageAt(resolvedConvId, now).catch((e: unknown) =>
      console.error('[send-external] lead update error:', e),
    );
  }

  // ── Select adapter and send ──────────────────────────────────

  try {
    const adapter = getAdapter(channel.provider);
    const result = await adapter(
      channel.credentials as Record<string, string>,
      {
        phone:       targetPhone,
        content:     content || '',
        type,
        mediaUrl:    media_url,
        delayTyping: 2,
      },
      config.zapiClientToken,
    );

    if (result.success) {
      if (messageId) {
        await updateMessageStatus(messageId, {
          status:              'sent',
          provider_message_id: result.providerMessageId || null,
        });
      }

      console.log(
        `[send-external] ✅ Sent msg=${messageId ?? 'no-persist'} conv=${resolvedConvId ?? 'first-contact'} provider=${channel.provider} provider_id=${result.providerMessageId}`,
      );

      res.json({ ok: true, message_id: messageId, status: 'sent', provider_message_id: result.providerMessageId });
    } else {
      if (messageId) {
        await updateMessageStatus(messageId, {
          status:   'failed',
          metadata: { error: result.error },
        });
      }

      console.error(
        `[send-external] ❌ Send failed msg=${messageId ?? 'no-persist'} conv=${resolvedConvId ?? 'first-contact'} error=${result.error}`,
      );

      res.status(502).json({ ok: false, message_id: messageId, status: 'failed', error: result.error });
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);

    if (messageId) {
      await updateMessageStatus(messageId, {
        status:   'failed',
        metadata: { error: errMsg },
      });
    }

    console.error('[send-external] Adapter error:', errMsg);
    res.status(500).json({ ok: false, message_id: messageId, status: 'failed', error: errMsg });
  }
});
