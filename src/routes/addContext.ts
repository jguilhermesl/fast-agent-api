import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { appendHistory } from '../memory/redis';

export const addContextRouter = Router();

// ── Request validation ────────────────────────────────────────

const AddContextSchema = z.object({
  agent_id: z.string().min(1),
  phone: z.string().min(1),
  content: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  type: z.enum(['text', 'image', 'video', 'audio', 'ptt', 'document']).default('text'),
});

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

// ── POST /api/add-context ─────────────────────────────────────

/**
 * Add a message to Redis conversation history without sending via WhatsApp.
 * Useful for external systems (like Lovable) that send messages through their own adapters
 * but still need to maintain context in Redis for the AI.
 */
addContextRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  // Validate body
  const parsed = AddContextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ 
      error: 'Invalid request body', 
      details: parsed.error.flatten() 
    });
    return;
  }

  const { agent_id, phone, content, role, type } = parsed.data;

  // Build scopedClientId for Redis
  const scopedClientId = `${agent_id}:${phone}`;

  // Format content with media type prefix (similar to orchestrator and sendExternal logic)
  let redisContent = content;
  
  if (type !== 'text') {
    switch (type) {
      case 'image':
        redisContent = '[Imagem] ' + content;
        break;
      case 'video':
        redisContent = '[Vídeo] ' + content;
        break;
      case 'audio':
      case 'ptt':
        redisContent = '[Áudio] ' + content;
        break;
      case 'document':
        redisContent = '[Documento] ' + content;
        break;
    }
  }

  try {
    await appendHistory(scopedClientId, [
      { role, content: redisContent }
    ]);

    console.log(`[add-context] ✅ Added to Redis: ${scopedClientId} | role=${role} | type=${type}`);

    res.json({ 
      ok: true, 
      message: 'Context added successfully',
      scoped_client_id: scopedClientId 
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[add-context] Redis error:', errMsg);
    
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to add context to Redis',
      details: errMsg 
    });
  }
});
