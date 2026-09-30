import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIError as OpenAIAPIError } from 'openai/error';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk/error';

// Reserva de crédito no Orquestrador (services/credito.ts).
//
// Cenário real: 02/09 e 29/09/2026 a OpenAI respondeu "429 You have no credits
// remaining" e todo agente `openai` passou a devolver "Só um momento, por favor."
// + transferência. Aqui a OpenAI (mock) devolve exatamente esse erro, montado com
// a classe real do SDK, e o teste prova que:
//   - o turno é refeito na Anthropic, Orquestrador E Executor;
//   - a resposta sai normal (sem transferência), com provider `anthropic`;
//   - `agent_error_logs` ganha uma linha `orchestrator-fallback-credito` com o
//     texto original do erro (é o que o alerta do n8n procura);
//   - 429 de rate limit comum NÃO aciona a reserva;
//   - `FALLBACK_CREDITO=off` desliga;
//   - reserva que também falha cai no fallback de segurança de sempre;
//   - agente configurado como `anthropic` continua com o Executor na OpenAI.

const m = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
  runExecutor: vi.fn(),
  logError: vi.fn(),
  saveTokenUsage: vi.fn(),
}));

vi.mock('../config', () => ({
  config: {
    openaiApiKey: 'sk-teste',
    anthropicApiKey: 'ak-teste',
    guardMode: 'shadow',
    cruzamentoMode: 'off',
    fallbackCredito: 'on',
    fallbackAnthropicModel: 'claude-sonnet-4-6',
    fallbackAnthropicExecutorModel: 'claude-sonnet-4-6',
  },
}));

vi.mock('openai', () => ({
  default: class { chat = { completions: { create: m.openaiCreate } }; },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: m.anthropicCreate }; },
}));

vi.mock('../memory/redis', () => ({
  getHistory: vi.fn().mockResolvedValue([]),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  lockStore: {},
  getUltimoTurno: vi.fn().mockResolvedValue(null),
  setUltimoTurno: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/fila', () => ({
  entrarNaFila: vi.fn().mockResolvedValue({ concorrente: false, esperouMs: 0, token: 'tok' }),
  sairDaFila: vi.fn().mockResolvedValue(undefined),
  TURN_LOCK_WAIT_MS: 30_000,
}));

vi.mock('../services/supabase', async () => {
  const pricing = await vi.importActual<typeof import('../services/pricing')>('../services/pricing');
  return {
    saveTokenUsage: m.saveTokenUsage,
    buildTokenLogEntry: pricing.buildTokenLogEntry,
    logError: m.logError,
    getAgentIntents: vi.fn().mockResolvedValue([]),
    getIntentLogsCompletos: vi.fn().mockResolvedValue([]),
    conversaTemCompromissoCriado: vi.fn().mockResolvedValue(false),
    logGuardShadow: vi.fn().mockResolvedValue(undefined),
    getMensagensDoCliente: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./executor', () => ({ runExecutor: m.runExecutor }));

import { runOrchestrator } from './orchestrator';
import { config } from '../config';
import type { ChatRequest } from '../types';

// `Headers` do SDK é um Record simples, não o `Headers` do fetch.
const h = {};
const erroSemCredito = () =>
  OpenAIAPIError.generate(429, {
    error: {
      message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      type: 'insufficient_quota',
      code: 'credit_balance_exhausted',
    },
  }, undefined, h);
const erroRateLimit = () =>
  OpenAIAPIError.generate(429, {
    error: { message: 'Rate limit reached for gpt-5.4 on tokens per min (TPM).', type: 'tokens', code: 'rate_limit_exceeded' },
  }, undefined, h);

const req: ChatRequest = {
  agent_id: 'agente-duda',
  conversation_id: 'conv-1',
  lead_id: 'lead-1',
  contact_phone: '5500000000000',
  scoped_client_id: 'agente-duda:5500000000000',
  client_messages: 'Quanto custa o ultrassom de abdome?',
  client_message_type: 'text',
  model_provider: 'openai',
  model_name: 'gpt-5.4',
  system_prompt: '# PAPEL\nVocê é a Duda.',
};

const RESPOSTA_FINAL = JSON.stringify({ mensagens: ['O ultrassom de abdome custa R$ 150,00.'], redirect_human: false, transfer_reason: null });

function anthropicResponde() {
  m.anthropicCreate
    .mockResolvedValueOnce({
      model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'chamar_executor', input: { tasks: [{ tipo: 'VENDA', objetivo: 'valor do ultrassom' }] } }],
      usage: { input_tokens: 13_000, output_tokens: 60 },
    })
    .mockResolvedValueOnce({
      model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
      content: [{ type: 'text', text: RESPOSTA_FINAL }],
      usage: { input_tokens: 13_300, output_tokens: 80 },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  config.fallbackCredito = 'on';
  m.runExecutor.mockResolvedValue({
    result: JSON.stringify({ valor: 'R$ 150,00' }),
    trace: {
      called: true, rounds: 2, model: 'claude-sonnet-4-6', tokens_input: 5000, tokens_output: 40, cost_usd: 0.01,
      tools_called: [{ tool: 'conferir_valores', arguments: { termo: 'ultrassom' }, result: { valor: 'R$ 150,00' } }],
    },
  });
});

afterEach(() => {
  config.fallbackCredito = 'on';
});

describe('runOrchestrator — reserva quando o crédito da OpenAI zera', () => {
  it('429 sem crédito → turno refeito na Anthropic, cliente recebe resposta normal', async () => {
    m.openaiCreate.mockRejectedValue(erroSemCredito());
    anthropicResponde();

    const resp = await runOrchestrator(req);

    expect(resp.mensagens).toEqual(['O ultrassom de abdome custa R$ 150,00.']);
    expect(resp.redirect_human).toBe(false);
    expect(resp.logs.orchestrator.provider).toBe('anthropic');
    expect(resp.logs.orchestrator.model).toBe('claude-sonnet-4-6');

    // Orquestrador na Anthropic com o modelo reserva e o mesmo system prompt.
    const [primeira] = m.anthropicCreate.mock.calls[0];
    expect(primeira.model).toBe('claude-sonnet-4-6');
    expect(primeira.system).toContain('Você é a Duda.');
    expect(primeira.tools.map((t: { name: string }) => t.name)).toEqual(['chamar_executor']);

    // Executor também na Anthropic: na OpenAI ele falharia pelo mesmo motivo.
    expect(m.runExecutor).toHaveBeenCalledTimes(1);
    expect(m.runExecutor.mock.calls[0][0]).toMatchObject({ provider: 'anthropic', conversation_id: 'conv-1' });

    // A reserva não esconde que a conta zerou: linha própria com o texto original.
    expect(m.logError).toHaveBeenCalledTimes(1);
    const log = m.logError.mock.calls[0][0];
    expect(log.layer).toBe('orchestrator-fallback-credito');
    expect(log.provider_failed).toBe('openai');
    expect(log.error_message).toMatch(/^Reserva anthropic\/claude-sonnet-4-6 respondeu\. Erro OpenAI: 429 You have no credits remaining/);

    // Custo gravado no modelo que de fato respondeu.
    expect(m.saveTokenUsage.mock.calls[0][0]).toMatchObject({ model_provider: 'anthropic', model_name: 'claude-sonnet-4-6' });
  });

  it('429 de rate limit comum NÃO aciona a reserva (fallback de segurança de sempre)', async () => {
    m.openaiCreate.mockRejectedValue(erroRateLimit());

    const resp = await runOrchestrator(req);

    expect(m.anthropicCreate).not.toHaveBeenCalled();
    expect(resp.mensagens).toEqual(['Só um momento, por favor.']);
    expect(resp.redirect_human).toBe(true);
    expect(m.logError).toHaveBeenCalledWith(expect.objectContaining({ layer: 'orchestrator', provider_failed: 'openai' }));
  });

  it('FALLBACK_CREDITO=off desliga a reserva', async () => {
    config.fallbackCredito = 'off';
    m.openaiCreate.mockRejectedValue(erroSemCredito());

    const resp = await runOrchestrator(req);

    expect(m.anthropicCreate).not.toHaveBeenCalled();
    expect(resp.mensagens).toEqual(['Só um momento, por favor.']);
    expect(m.logError.mock.calls[0][0]).toMatchObject({ layer: 'orchestrator', provider_failed: 'openai' });
    expect(m.logError.mock.calls[0][0].error_message).toMatch(/no credits remaining/);
  });

  it('reserva também falha (chave Anthropic inválida) → fallback de segurança, log com as duas causas', async () => {
    m.openaiCreate.mockRejectedValue(erroSemCredito());
    m.anthropicCreate.mockRejectedValue(
      AnthropicAPIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, h),
    );

    const resp = await runOrchestrator(req);

    expect(resp.mensagens).toEqual(['Só um momento, por favor.']);
    expect(resp.redirect_human).toBe(true);
    expect(m.logError).toHaveBeenCalledTimes(1);
    const log = m.logError.mock.calls[0][0];
    expect(log.provider_failed).toBe('openai+anthropic');
    expect(log.layer).toBe('orchestrator');
    expect(log.error_message).toMatch(/no credits remaining/);
    expect(log.error_message).toMatch(/invalid x-api-key/);
  });

  it('agente configurado como anthropic mantém o Executor na OpenAI (comportamento de antes)', async () => {
    anthropicResponde();

    const resp = await runOrchestrator({ ...req, model_provider: 'anthropic', model_name: 'claude-sonnet-4-6-20260301' });

    expect(resp.logs.orchestrator.provider).toBe('anthropic');
    expect(m.openaiCreate).not.toHaveBeenCalled();
    expect(m.runExecutor.mock.calls[0][0].provider).toBe('openai');
    expect(m.logError).not.toHaveBeenCalled();
  });
});
