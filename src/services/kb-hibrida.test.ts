import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mesmo padrão de `kb-similaridade.test.ts`: cliente Supabase mockado antes do import.
vi.mock('../config', () => ({
  config: { supabaseUrl: 'https://example.invalid', supabaseServiceKey: 'test-key' },
}));

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: vi.fn(), rpc: rpcMock }),
}));

import { searchKnowledgeBase } from './supabase';

// Linhas no formato de `buscar_conhecimento` (chat-flow-pilot-63, migration
// 20260930130100). Números medidos em produção em 30/09/2026 para a pergunta
// "preparo endoscopia jejum" na Duda: só a Endoscopia passa; os outros preparos
// empatavam no vetor (0,49–0,50) e, antes da busca por palavra, voltavam juntos.
const linha = (nome: string, similarity: number, lexical: number, passou: boolean) => ({
  chunk_id: `c-${nome}`,
  training_id: `t-${nome}`,
  training_name: nome,
  injection_mode: 'ondemand',
  content: `Preparos de exame — ${nome}\n\ntexto de ${nome}`,
  similarity,
  lexical,
  score: similarity + 0.3 * lexical,
  rrf: 0,
  passou,
});

describe('searchKnowledgeBase — busca híbrida', () => {
  beforeEach(() => rpcMock.mockReset());

  it('com o texto da busca, chama buscar_conhecimento e entrega só quem passou do corte', async () => {
    rpcMock.mockResolvedValue({
      data: [linha('Endoscopia', 0.65, 1, true), linha('Cultura de orofaringe', 0.5, 0.4, false), linha('Ressonância', 0.49, 0.4, false)],
      error: null,
    });

    const r = await searchKnowledgeBase('agent-1', [0.1, 0.2], 3, {}, 'preparo endoscopia jejum');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe('buscar_conhecimento');
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ p_agent_id: 'agent-1', p_query: 'preparo endoscopia jejum', p_match_count: 3 });
    expect(r).toContain('texto de Endoscopia');
    expect(r).not.toContain('orofaringe');
  });

  it('ninguém passou: devolve o "não achei" que o handler traduz para status empty', async () => {
    rpcMock.mockResolvedValue({ data: [linha('Casos específicos', 0.44, 0, false)], error: null });
    const r = await searchKnowledgeBase('agent-1', [0.1], 3, {}, 'endereço da clínica');
    expect(r).toBe('(nenhuma informação relevante encontrada na base de conhecimento)');
  });

  it('função híbrida fora do ar: cai no match_documents antigo, sem derrubar a tool', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.buscar_conhecimento' } })
      .mockResolvedValueOnce({ data: [{ id: 'x', content: 'Preparo do PSA', similarity: 0.52, metadata: {} }], error: null });

    const r = await searchKnowledgeBase('agent-1', [0.1], 3, { minSimilarity: 0.45 }, 'preparo psa');

    expect(rpcMock.mock.calls.map((c) => c[0])).toEqual(['buscar_conhecimento', 'match_documents']);
    expect(r).toContain('Preparo do PSA');
  });

  it('sem texto da busca, segue o caminho antigo (compatível com quem ainda não passa a query)', async () => {
    rpcMock.mockResolvedValue({ data: [{ id: 'x', content: 'Preparo do PSA', similarity: 0.52, metadata: {} }], error: null });
    await searchKnowledgeBase('agent-1', [0.1]);
    expect(rpcMock.mock.calls[0][0]).toBe('match_documents');
  });

  it('respeita o limite mesmo se a função devolver mais aprovados', async () => {
    rpcMock.mockResolvedValue({
      data: [linha('A', 0.7, 1, true), linha('B', 0.69, 1, true), linha('C', 0.68, 1, true), linha('D', 0.67, 1, true)],
      error: null,
    });
    const r = await searchKnowledgeBase('agent-1', [0.1], 2, {}, 'x');
    expect(r).toContain('texto de A');
    expect(r).toContain('texto de B');
    expect(r).not.toContain('texto de C');
  });
});
