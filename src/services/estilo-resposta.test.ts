import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config', () => ({
  config: { supabaseUrl: 'https://example.invalid', supabaseServiceKey: 'test-key' },
}));

// from('agents').select('estilo:prompt_config->>response_style').eq('id', x).maybeSingle()
const { maybeSingleMock, selectMock, fromMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const selectMock = vi.fn(() => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  return { maybeSingleMock, selectMock, fromMock };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock, rpc: vi.fn() }),
}));

import { getEstiloResposta } from './supabase';

describe('getEstiloResposta', () => {
  beforeEach(() => {
    maybeSingleMock.mockReset();
    fromMock.mockClear();
    selectMock.mockClear();
  });

  it('lê só o response_style do prompt_config (não baixa a persona inteira)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { estilo: 'conciso' }, error: null });
    expect(await getEstiloResposta('agente-a')).toBe('conciso');
    expect(fromMock).toHaveBeenCalledWith('agents');
    expect(selectMock).toHaveBeenCalledWith('estilo:prompt_config->>response_style');
  });

  it('guarda em cache: a segunda leitura do mesmo agente não vai ao banco', async () => {
    maybeSingleMock.mockResolvedValue({ data: { estilo: 'detalhado' }, error: null });
    expect(await getEstiloResposta('agente-b')).toBe('detalhado');
    expect(await getEstiloResposta('agente-b')).toBe('detalhado');
    expect(maybeSingleMock).toHaveBeenCalledTimes(1);
  });

  it('campo ausente → null (vale o sufixo padrão)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { estilo: null }, error: null });
    expect(await getEstiloResposta('agente-c')).toBeNull();
  });

  it('erro do Supabase → null e NÃO fica em cache (tenta de novo no próximo turno)', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    expect(await getEstiloResposta('agente-d')).toBeNull();
    maybeSingleMock.mockResolvedValueOnce({ data: { estilo: 'conciso' }, error: null });
    expect(await getEstiloResposta('agente-d')).toBe('conciso');
    expect(maybeSingleMock).toHaveBeenCalledTimes(2);
  });

  it('exceção de rede → null, sem derrubar o turno', async () => {
    maybeSingleMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(getEstiloResposta('agente-e')).resolves.toBeNull();
  });
});
