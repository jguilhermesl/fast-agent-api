import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config', () => ({
  config: { supabaseUrl: 'https://example.invalid', supabaseServiceKey: 'test-key' },
}));

// from('agents').select('prompt_config').eq('id', x).maybeSingle()
const { maybeSingleMock, selectMock, fromMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const selectMock = vi.fn(() => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  return { maybeSingleMock, selectMock, fromMock };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: fromMock, rpc: vi.fn() }),
}));

import { getEstiloNoCodigo } from './supabase';

describe('getEstiloNoCodigo', () => {
  beforeEach(() => {
    maybeSingleMock.mockReset();
    fromMock.mockClear();
    selectMock.mockClear();
  });

  it('lê prompt_config.estilo do agente', async () => {
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: { estilo: { emoji: false, dividir: true } } }, error: null });
    expect(await getEstiloNoCodigo('agente-a')).toEqual({ emoji: false, dividir: true });
    expect(fromMock).toHaveBeenCalledWith('agents');
    expect(selectMock).toHaveBeenCalledWith('prompt_config');
  });

  it('sem a chave → undefined (nada muda)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: { response_style: 'conciso' } }, error: null });
    expect(await getEstiloNoCodigo('agente-b')).toBeUndefined();
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: null }, error: null });
    expect(await getEstiloNoCodigo('agente-b2')).toBeUndefined();
  });

  it('chave com valor que não é objeto → undefined', async () => {
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: { estilo: 'sem emoji' } }, error: null });
    expect(await getEstiloNoCodigo('agente-c')).toBeUndefined();
  });

  it('chave vazia ({}) → objeto vazio (só o negrito converte)', async () => {
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: { estilo: {} } }, error: null });
    expect(await getEstiloNoCodigo('agente-d')).toEqual({});
  });

  it('guarda em cache: a segunda leitura do mesmo agente não vai ao banco', async () => {
    maybeSingleMock.mockResolvedValue({ data: { prompt_config: { estilo: { emoji: false } } }, error: null });
    expect(await getEstiloNoCodigo('agente-e')).toEqual({ emoji: false });
    expect(await getEstiloNoCodigo('agente-e')).toEqual({ emoji: false });
    expect(maybeSingleMock).toHaveBeenCalledTimes(1);
  });

  it('erro do Supabase → undefined e NÃO fica em cache', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    expect(await getEstiloNoCodigo('agente-f')).toBeUndefined();
    maybeSingleMock.mockResolvedValueOnce({ data: { prompt_config: { estilo: { dividir: false } } }, error: null });
    expect(await getEstiloNoCodigo('agente-f')).toEqual({ dividir: false });
    expect(maybeSingleMock).toHaveBeenCalledTimes(2);
  });

  it('exceção de rede → undefined, sem derrubar o turno', async () => {
    maybeSingleMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(getEstiloNoCodigo('agente-g')).resolves.toBeUndefined();
  });
});
