import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mesmo padrão de `supabase.test.ts`: `supabase.ts` cria o cliente no import e
// `config` exige env var, então os dois módulos são mockados antes.
vi.mock('../config', () => ({
  config: {
    supabaseUrl: 'https://example.invalid',
    supabaseServiceKey: 'test-key',
  },
}));

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: vi.fn(), rpc: rpcMock }),
}));

import { searchKnowledgeBase } from './supabase';

// Os números aqui não são inventados: são a saída real de `match_documents` medida
// em 28/08/2026 contra os treinamentos da Duda (agent 45bc75c9). A função SQL faz
// `1 - (embedding <=> query)`, e `<=>` é distância de cosseno — logo `similarity` é
// o cosseno, teto 1,0. Texto que de fato responde à pergunta tira 0,40 a 0,55.
const SIMILARIDADE_MEDIDA_PREPARO = 0.5345; // "preciso do preparo do ultrassom de abdome total"
const SIMILARIDADE_MEDIDA_RESPOSTA = 0.4134; // "vocês têm outra unidade?"

describe('searchKnowledgeBase — limiar de similaridade', () => {
  beforeEach(() => rpcMock.mockReset());

  it('entrega o chunk que a busca vetorial considerou relevante', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          content: 'Tome 40 gotas de Flagass (Simeticona) após o jantar do dia anterior.',
          similarity: SIMILARIDADE_MEDIDA_PREPARO,
          metadata: { agent_id: 'agent-1' },
        },
      ],
      error: null,
    });

    const resultado = await searchKnowledgeBase('agent-1', [0.1, 0.2]);

    expect(resultado).toContain('Flagass');
  });

  it('entrega também o chunk de similaridade mais baixa que a função SQL aprovou', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          content: 'Não temos outra unidade fora a LP Saúde Rio Doce.',
          similarity: SIMILARIDADE_MEDIDA_RESPOSTA,
          metadata: { agent_id: 'agent-1' },
        },
      ],
      error: null,
    });

    const resultado = await searchKnowledgeBase('agent-1', [0.1, 0.2]);

    expect(resultado).toContain('outra unidade');
  });

  it('descarta chunk abaixo do piso, para o filtro não virar decoração', async () => {
    rpcMock.mockResolvedValue({
      data: [{ content: 'Texto sem relação nenhuma com a pergunta.', similarity: 0.12, metadata: {} }],
      error: null,
    });

    const resultado = await searchKnowledgeBase('agent-1', [0.1, 0.2]);

    expect(resultado).toBe('(nenhuma informação relevante encontrada na base de conhecimento)');
  });
});
