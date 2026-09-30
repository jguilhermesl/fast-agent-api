import { describe, it, expect, vi, beforeEach } from 'vitest';

// Executor no provedor reserva (Anthropic), usado quando o crédito da OpenAI zera
// (services/credito.ts). O que este teste prova: com `provider: 'anthropic'` o
// Executor NÃO toca na OpenAI, chama as mesmas ferramentas pelo mesmo dispatch
// (estática e intenção dinâmica), devolve o resultado de cada uma como
// `tool_result` e contabiliza tokens/custo no modelo Anthropic.

const m = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
  saveTokenUsage: vi.fn(),
  logError: vi.fn(),
  getAgentIntents: vi.fn(),
  getIntentLogs: vi.fn(),
  handleAtualizarLeadCRM: vi.fn(),
  handleExecutarIntent: vi.fn(),
  handleEnviarArquivo: vi.fn(),
  handleKnowledgeBase: vi.fn(),
}));

vi.mock('../config', () => ({
  config: {
    openaiApiKey: 'sk-teste',
    anthropicApiKey: 'ak-teste',
    fallbackAnthropicExecutorModel: 'claude-sonnet-4-6',
  },
}));

vi.mock('openai', () => ({
  default: class { chat = { completions: { create: m.openaiCreate } }; },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create: m.anthropicCreate }; },
}));

vi.mock('../services/supabase', async () => {
  const pricing = await vi.importActual<typeof import('../services/pricing')>('../services/pricing');
  return {
    getAgentIntents: m.getAgentIntents,
    getIntentLogs: m.getIntentLogs,
    saveTokenUsage: m.saveTokenUsage,
    logError: m.logError,
    calcCostUsd: pricing.calcCostUsd,
    buildTokenLogEntry: pricing.buildTokenLogEntry,
  };
});

vi.mock('../tools/handlers', () => ({
  handleAtualizarLeadCRM: m.handleAtualizarLeadCRM,
  handleExecutarIntent: m.handleExecutarIntent,
  handleEnviarArquivo: m.handleEnviarArquivo,
  handleKnowledgeBase: m.handleKnowledgeBase,
}));

import { runExecutor } from './executor';
import type { ExecutorInput } from '../types';

const input: ExecutorInput = {
  query: JSON.stringify([{ tipo: 'VENDA', objetivo: 'valor do ultrassom' }, { tipo: 'CRM', objetivo: 'avançar', valor: 'orçamento' }]),
  agent_id: 'agente-1',
  conversation_id: 'conv-1',
  lead_id: 'lead-1',
  contact_phone: '5500000000000',
  scoped_client_id: 'agente-1:5500000000000',
  client_messages: 'Quanto custa o ultrassom?',
  conversation_context: 'Cliente: oi\nAgente: Olá!',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getAgentIntents.mockResolvedValue([
    {
      id: 'i-1',
      slug: 'conferir_valores',
      trigger_description: 'Consulta o valor de um exame',
      request_schema: { parameters: [{ name: 'termo', type: 'string', required: true }] },
    },
  ]);
  m.getIntentLogs.mockResolvedValue([]);
  m.handleAtualizarLeadCRM.mockResolvedValue(JSON.stringify({ ok: true, stage: 'orçamento' }));
  m.handleExecutarIntent.mockResolvedValue(JSON.stringify({ valor: 'R$ 150,00' }));
});

describe('runExecutor — provedor reserva Anthropic', () => {
  it('chama as ferramentas certas, devolve tool_result e não toca na OpenAI', async () => {
    m.anthropicCreate
      .mockResolvedValueOnce({
        model: 'claude-sonnet-4-6-20260301',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Vou consultar.' },
          { type: 'tool_use', id: 'tu_1', name: 'conferir_valores', input: { termo: 'ultrassom' } },
          { type: 'tool_use', id: 'tu_2', name: 'atualizar_lead_crm', input: { stage: 'orçamento' } },
        ],
        usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200 },
      })
      .mockResolvedValueOnce({
        model: 'claude-sonnet-4-6-20260301',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Ultrassom: R$ 150,00. CRM em orçamento.' }],
        usage: { input_tokens: 1300, output_tokens: 30 },
      });

    const r = await runExecutor({ ...input, provider: 'anthropic' });

    expect(m.openaiCreate).not.toHaveBeenCalled();
    expect(m.anthropicCreate).toHaveBeenCalledTimes(2);

    // 1ª chamada: modelo da reserva, manual do Executor no `system`, mesmas tools.
    const [primeira] = m.anthropicCreate.mock.calls[0];
    expect(primeira.model).toBe('claude-sonnet-4-6');
    expect(typeof primeira.system).toBe('string');
    expect(primeira.system).toContain('<acoes_executadas>');
    expect(primeira.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['atualizar_lead_crm', 'enviar_arquivo', 'agent_knowledge_base', 'conferir_valores']),
    );
    expect(primeira.tools.find((t: { name: string }) => t.name === 'conferir_valores').input_schema).toMatchObject({
      properties: { termo: { type: 'string' } },
      required: ['termo'],
    });
    expect(primeira.messages[0].content).toContain('<tarefas>');

    // Dispatch: intenção dinâmica e ferramenta estática, com os argumentos do modelo.
    expect(m.handleExecutarIntent).toHaveBeenCalledWith(
      { intent_key: 'conferir_valores', arguments: { termo: 'ultrassom' } },
      expect.objectContaining({ conversation_id: 'conv-1', provider: 'anthropic' }),
    );
    expect(m.handleAtualizarLeadCRM).toHaveBeenCalledWith({ stage: 'orçamento' }, expect.objectContaining({ lead_id: 'lead-1' }));

    // 2ª chamada: resposta do assistente + tool_result com o retorno de cada ferramenta.
    const [segunda] = m.anthropicCreate.mock.calls[1];
    const ultimo = segunda.messages[segunda.messages.length - 1];
    expect(ultimo.role).toBe('user');
    expect(ultimo.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ valor: 'R$ 150,00' }) },
      { type: 'tool_result', tool_use_id: 'tu_2', content: JSON.stringify({ ok: true, stage: 'orçamento' }) },
    ]);

    // Resultado e contabilidade.
    expect(r.result).toBe('Ultrassom: R$ 150,00. CRM em orçamento.');
    expect(r.trace.model).toBe('claude-sonnet-4-6-20260301');
    expect(r.trace.rounds).toBe(2);
    expect(r.trace.tokens_input).toBe(1000 + 200 + 1300); // cacheado da Anthropic vem fora de input_tokens
    expect(r.trace.tokens_output).toBe(80);
    expect(r.trace.tools_called.map((t) => t.tool)).toEqual(['conferir_valores', 'atualizar_lead_crm']);
    expect(r.trace.cost_usd).toBeGreaterThan(0);

    expect(m.saveTokenUsage).toHaveBeenCalledTimes(1);
    expect(m.saveTokenUsage.mock.calls[0][0]).toMatchObject({
      model_provider: 'anthropic',
      model_name: 'claude-sonnet-4-6-20260301',
      input_tokens: 2500,
      cached_input_tokens: 200,
    });
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('ferramenta desconhecida vira erro no tool_result, sem derrubar o turno', async () => {
    m.anthropicCreate
      .mockResolvedValueOnce({
        model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_x', name: 'inventada', input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 },
      });

    const r = await runExecutor({ ...input, provider: 'anthropic' });
    const [segunda] = m.anthropicCreate.mock.calls[1];
    expect(segunda.messages.at(-1).content[0].content).toContain('Tool desconhecida: inventada');
    expect(r.result).toBe('ok');
  });

  it('orçamento de tempo esgotado: não chama o modelo e registra executor-deadline com provider anthropic', async () => {
    const r = await runExecutor({
      ...input,
      provider: 'anthropic',
      deadline: { expired: () => true, remaining: () => 0 },
    });
    expect(m.anthropicCreate).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledWith(expect.objectContaining({ layer: 'executor-deadline', provider_failed: 'anthropic' }));
    expect(r.result).toBe('(orçamento de tempo do turno esgotado)');
  });
});

describe('runExecutor — caminho normal (sem provider) continua na OpenAI', () => {
  it('usa gpt-5.4-mini e não toca na Anthropic', async () => {
    m.openaiCreate.mockResolvedValueOnce({
      model: 'gpt-5.4-mini-2026-03-17',
      choices: [{ message: { content: 'nada a fazer', tool_calls: undefined } }],
      usage: { prompt_tokens: 7000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 2176 } },
    });

    const r = await runExecutor(input);

    expect(m.anthropicCreate).not.toHaveBeenCalled();
    expect(m.openaiCreate).toHaveBeenCalledTimes(1);
    expect(m.openaiCreate.mock.calls[0][0].model).toBe('gpt-5.4-mini');
    expect(r.result).toBe('nada a fazer');
    expect(m.saveTokenUsage.mock.calls[0][0]).toMatchObject({ model_provider: 'openai', cached_input_tokens: 2176 });
  });
});
