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

// 24/09/2026, Duda: corte e exclusão por agente (prompt_config.kb). Números da auditoria de
// dados: o PSA pedido de verdade tirou 0,50–0,57; Preparo sem relação com a pergunta ficava
// entre 0,30 e 0,45.
describe('searchKnowledgeBase — opções por agente', () => {
  beforeEach(() => rpcMock.mockReset());
  const chunk = (id: string, similarity: number, content = `texto ${id}`) => ({ id, content, similarity, metadata: { agent_id: 'agent-1' } });

  it('sem opções, vale o corte global de sempre (0,30)', async () => {
    rpcMock.mockResolvedValue({ data: [chunk('a', 0.36)], error: null });
    expect(await searchKnowledgeBase('agent-1', [0.1])).toContain('texto a');
  });

  it('corte do agente em 0,45 derruba o Preparo de passagem e mantém o PSA pedido', async () => {
    rpcMock.mockResolvedValue({ data: [chunk('psa', 0.52, 'Preparo do PSA'), chunk('cultura', 0.38, 'Preparo da cultura')], error: null });
    const r = await searchKnowledgeBase('agent-1', [0.1], 3, { minSimilarity: 0.45 });
    expect(r).toContain('Preparo do PSA');
    expect(r).not.toContain('Preparo da cultura');
  });

  it('exclui o treinamento que já vai no prompt e pede a mais para completar o limite', async () => {
    rpcMock.mockResolvedValue({ data: [chunk('objecoes', 0.6, 'OBJEÇÃO'), chunk('b', 0.5), chunk('c', 0.49), chunk('d', 0.48)], error: null });
    const r = await searchKnowledgeBase('agent-1', [0.1], 3, { excluirIds: new Set(['objecoes']) });
    expect(rpcMock.mock.calls[0][1].match_count).toBe(4);
    expect(r).not.toContain('OBJEÇÃO');
    expect(r).toContain('texto b');
    expect(r).toContain('texto d');
  });
});
