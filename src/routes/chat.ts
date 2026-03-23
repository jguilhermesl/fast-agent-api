import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { runOrchestrator } from '../agents/orchestrator';

export const chatRouter = Router();

// ── Request validation ────────────────────────────────────────

const ChatRequestSchema = z.object({
  agent_id:             z.string().min(1),
  conversation_id:      z.string().min(1),
  lead_id:              z.string().min(1),
  contact_phone:        z.string().min(1),
  scoped_client_id:     z.string().min(1),
  client_messages:      z.string().min(1),
  client_message_type:  z.enum(['text', 'image_analysis', 'audio_transcription']).default('text'),
  model_provider:       z.enum(['openai', 'anthropic', 'gemini']).default('openai'),
  model_name:           z.string().default('gpt-4.1-mini'),
  system_prompt:        z.string().min(1),
  tenant_id:            z.string().optional(),
});

// ── Auth middleware ────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  if (token !== config.apiSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── POST /api/chat ────────────────────────────────────────────

chatRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parseResult = ChatRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: parseResult.error.flatten(),
    });
    return;
  }

  const data = parseResult.data;
  const start = Date.now();

  console.log(`[Chat] → agent=${data.agent_id} conversation=${data.conversation_id} provider=${data.model_provider}/${data.model_name}`);

  try {
    const response = await runOrchestrator(data);
    const elapsed = Date.now() - start;

    console.log(`[Chat] ← mensagens=${response.mensagens.length} redirect=${response.redirect_human} elapsed=${elapsed}ms`);

    res.json(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Chat] Unhandled error:', msg);

    // Sempre retorna resposta válida para o n8n nunca quebrar
    res.status(200).json({
      mensagens: ['Desculpe, estou com uma instabilidade. Pode tentar novamente? 🙏'],
      redirect_human: false,
    });
  }
});

// ── GET /health ───────────────────────────────────────────────

chatRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});
