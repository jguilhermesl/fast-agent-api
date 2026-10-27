import { describe, it, expect } from 'vitest';
import { cortarSeConversaNova, chaveMarcador, chaveAnterior, type MemoriaStore } from './conversa';

function storeEmMemoria(inicial: Record<string, string> = {}) {
  const m = new Map(Object.entries(inicial));
  const store: MemoriaStore = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    del: async (k) => { m.delete(k); },
  };
  return { store, m };
}

const K = 'b63f50d1-4e37-4ab2-a164-3e53d1eb7d6e:558191693706';
const HIST = JSON.stringify([{ role: 'user', content: 'Oiii' }, { role: 'assistant', content: 'Bom dia, João…' }]);

describe('cortarSeConversaNova', () => {
  it('mesma conversa: não toca no histórico', async () => {
    const { store, m } = storeEmMemoria({ [K]: HIST, [chaveMarcador(K)]: 'lead-1' });
    expect(await cortarSeConversaNova(store, K, 'lead-1')).toBe('mesma');
    expect(m.get(K)).toBe(HIST);
    expect(m.has(chaveAnterior(K))).toBe(false);
  });

  it('conversa nova do mesmo telefone: histórico vai para anterior e a nova começa vazia', async () => {
    const { store, m } = storeEmMemoria({ [K]: HIST, [chaveMarcador(K)]: 'lead-apagado' });
    expect(await cortarSeConversaNova(store, K, 'lead-2')).toBe('cortou');
    expect(m.has(K)).toBe(false);
    expect(m.get(chaveAnterior(K))).toBe(HIST);
    expect(m.get(chaveMarcador(K))).toBe('lead-2');
  });

  it('sem marcador (memória de antes da chave): não corta, só marca', async () => {
    const { store, m } = storeEmMemoria({ [K]: HIST });
    expect(await cortarSeConversaNova(store, K, 'lead-1')).toBe('marcou');
    expect(m.get(K)).toBe(HIST);
    expect(m.get(chaveMarcador(K))).toBe('lead-1');
  });

  it('conversa nova sem histórico: só troca o marcador', async () => {
    const { store, m } = storeEmMemoria({ [chaveMarcador(K)]: 'lead-1' });
    expect(await cortarSeConversaNova(store, K, 'lead-2')).toBe('cortou');
    expect(m.has(chaveAnterior(K))).toBe(false);
    expect(m.get(chaveMarcador(K))).toBe('lead-2');
  });

  it('segundo turno da conversa nova não corta de novo', async () => {
    const { store, m } = storeEmMemoria({ [K]: HIST, [chaveMarcador(K)]: 'lead-1' });
    await cortarSeConversaNova(store, K, 'lead-2');
    m.set(K, JSON.stringify([{ role: 'user', content: 'oi' }]));
    expect(await cortarSeConversaNova(store, K, 'lead-2')).toBe('mesma');
    expect(m.get(K)).toContain('oi');
  });
});
