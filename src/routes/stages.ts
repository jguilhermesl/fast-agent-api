import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { supabase } from '../services/supabase';

export const stagesRouter = Router();

// ── Request validation ────────────────────────────────────────

const StagesRequestSchema = z.object({
  agent_id: z.string().min(1),
  lead_id: z.string().min(1),
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

// ── GET /api/stages ────────────────────────────────────────────

stagesRouter.get('/', authMiddleware, async (req: Request, res: Response) => {
  const parseResult = StagesRequestSchema.safeParse(req.query);

  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request parameters',
      details: parseResult.error.flatten(),
    });
    return;
  }

  const { agent_id, lead_id } = parseResult.data;

  console.log(`[Stages] → agent=${agent_id} lead=${lead_id}`);

  try {
    // 1. Buscar dados do agente (tenant_id)
    const { data: agentData, error: agentError } = await supabase
      .from('agents')
      .select('id, tenant_id')
      .eq('id', agent_id)
      .single();

    if (agentError || !agentData) {
      console.error('[Stages] Agent not found:', agentError?.message);
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const tenant_id = agentData.tenant_id;

    // 2. Buscar estágios disponíveis (stages)
    const { data: stagesData, error: stagesError } = await supabase
      .from('crm_stages')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('order', { ascending: true });

    if (stagesError) {
      console.error('[Stages] Error fetching stages:', stagesError.message);
      res.status(500).json({ error: 'Failed to fetch stages' });
      return;
    }

    // 3. Buscar dados do lead (incluindo estágio atual)
    const { data: leadData, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .single();

    if (leadError || !leadData) {
      console.error('[Stages] Lead not found:', leadError?.message);
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // 4. Retornar resposta estruturada
    const response = {
      tenant_id,
      stages: stagesData || [],
      agent_id,
      lead: leadData,
    };

    console.log(`[Stages] ← tenant=${tenant_id} stages_count=${stagesData?.length || 0}`);

    res.json(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Stages] Unhandled error:', msg);

    res.status(500).json({
      error: 'Internal server error',
      message: msg,
    });
  }
});

// ── GET /health ───────────────────────────────────────────────

stagesRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', route: 'stages', ts: new Date().toISOString() });
});
