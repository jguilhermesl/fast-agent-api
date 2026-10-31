import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { esquemaEstilo } from './esquema-estilo';
import { config } from '../config';
import { runOrchestrator } from '../agents/orchestrator';
import { limparEventosDoProvedor } from '../agents/entrada';
import { iniciarSombraMontador } from '../agents/montador/executar-sombra';
import { montarPromptDoBanco } from '../agents/montador/prompt-do-banco';

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
  model_provider:       z.enum(['openai', 'anthropic', 'gemini', 'openrouter']).default('openai'),
  model_name:           z.string().default('gpt-4.1-mini'),
  // Opcional quando `montar_prompt` vem true: o prompt sai do montador (src/agents/montador),
  // o mesmo texto do Prompt_Variavel do n8n. É o caminho da demonstração pública (demo-chat).
  system_prompt:        z.string().min(1).optional(),
  montar_prompt:        z.boolean().optional(),
  tenant_id:            z.string().optional(),
  executor_model:       z.string().optional(),
  cotacao_no_codigo:    z.boolean().optional(),
  estilo:               esquemaEstilo.optional(),
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

  const corpo = parseResult.data;
  const start = Date.now();

  let systemPrompt = corpo.system_prompt;
  if (!systemPrompt && corpo.montar_prompt) {
    try {
      systemPrompt = await montarPromptDoBanco(corpo.agent_id, corpo.contact_phone);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Chat] montador falhou:', msg);
      res.status(500).json({ error: 'Não foi possível montar o prompt do agente' });
      return;
    }
  }
  if (!systemPrompt) {
    res.status(400).json({ error: 'Invalid request body', details: { fieldErrors: { system_prompt: ['Required'] } } });
    return;
  }
  const data = { ...corpo, system_prompt: systemPrompt };

  console.log(`[Chat] → agent=${data.agent_id} conversation=${data.conversation_id} provider=${data.model_provider}/${data.model_name}`);

  // Evento do provedor (mensagem editada/apagada) chega como texto. Sem fala do
  // cliente, não há o que responder: `mensagens: []` faz o n8n não enviar nada.
  const falaDoCliente = limparEventosDoProvedor(data.client_messages);
  if (!falaDoCliente) {
    console.log(`[Chat] ← ignorado: só evento do provedor (${JSON.stringify(data.client_messages.slice(0, 80))})`);
    res.json({ mensagens: [], redirect_human: false });
    return;
  }
  data.client_messages = falaDoCliente;

  // Montador em sombra (MONTADOR_SOMBRA=on, ver agents/montador/): só compara e registra o prompt montado
  // no código com o `system_prompt` do n8n. Sem a variável devolve null e nada roda. Nunca lança.
  // Prompt montado aqui mesmo: comparar com ele próprio não mede nada.
  const concluirSombra = corpo.montar_prompt ? null : iniciarSombraMontador(data);

  try {
    const response = await runOrchestrator(data);
    const elapsed = Date.now() - start;

    console.log(`[Chat] ← mensagens=${response.mensagens.length} redirect=${response.redirect_human} elapsed=${elapsed}ms`);

    res.json(response);
    concluirSombra?.(); // depois da resposta: sem await, não altera o que o cliente HTTP recebeu
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
