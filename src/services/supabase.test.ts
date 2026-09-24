import { describe, it, expect, vi, beforeEach } from 'vitest';

// `supabase.ts` cria o cliente service_role no import (`createClient(config.supabaseUrl, ...)`)
// e `config` exige env var via `required()`. Mocka os dois módulos ANTES do import — vitest
// içaest chamada, então a ordem no arquivo não importa, mas escrever assim documenta a intenção.
vi.mock('../config', () => ({
  config: {
    supabaseUrl: 'https://example.invalid',
    supabaseServiceKey: 'test-key',
  },
}));

// `vi.mock` é içado (hoisted) acima de qualquer `const` do topo do arquivo — sem
// `vi.hoisted`, `eqMock`/`fromMock` seriam lidos antes de existir ("Cannot access
// before initialization"). `vi.hoisted` sobe a criação junto com o mock.
const { eqMock, fromMock } = vi.hoisted(() => {
  const eqMock = vi.fn();
  // .eq('agent_id', ...).eq('status', 'active'): o eqMock recebe os dois filtros juntos.
  const fromMock = vi.fn(() => ({ select: () => ({ eq: (c1: string, v1: string) => ({ eq: (c2: string, v2: string) => eqMock(c1, v1, c2, v2) }) }) }));
  return { eqMock, fromMock };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock, rpc: vi.fn() }),
}));

import { getAgentIntents } from './supabase';

describe('getAgentIntents — erro de leitura vs. lista vazia real', () => {
  beforeEach(() => {
    eqMock.mockReset();
    fromMock.mockClear();
  });

  it('devolve null quando o Supabase responde erro — NÃO [] (guard tem que saber que não leu)', async () => {
    eqMock.mockResolvedValue({ data: null, error: { message: 'timeout de rede' } });

    const result = await getAgentIntents('agent-1');

    expect(result).toBeNull();
  });

  it('devolve [] quando a leitura funciona e o agente de fato não tem intents', async () => {
    eqMock.mockResolvedValue({ data: [], error: null });

    const result = await getAgentIntents('agent-1');

    expect(result).toEqual([]);
  });

  it('devolve a lista quando a leitura funciona e há intents', async () => {
    const intents = [{ id: '1', slug: 'agendar_consulta', trigger_description: 'x' }];
    eqMock.mockResolvedValue({ data: intents, error: null });

    const result = await getAgentIntents('agent-1');

    expect(result).toEqual(intents);
  });
});

describe('getAgentIntents — só intenção ativa vira ferramenta', () => {
  it('filtra por agente E por status active', async () => {
    eqMock.mockReset();
    eqMock.mockResolvedValue({ data: [], error: null });
    await getAgentIntents('agent-1');
    expect(eqMock).toHaveBeenCalledWith('agent_id', 'agent-1', 'status', 'active');
  });
});
