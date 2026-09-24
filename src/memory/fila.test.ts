import { describe, it, expect, vi } from 'vitest';
import { entrarNaFila, sairDaFila, chaveDaFila, type LockStore } from './fila';

// Redis de mentira com TTL, no relógio falso do teste.
function redisEmMemoria(agora: () => number) {
  const m = new Map<string, { valor: string; expira: number }>();
  const store: LockStore = {
    setNx: vi.fn(async (k: string, v: string, ttl: number) => {
      const atual = m.get(k);
      if (atual && atual.expira > agora()) return false;
      m.set(k, { valor: v, expira: agora() + ttl });
      return true;
    }),
    delIfEquals: vi.fn(async (k: string, v: string) => {
      if (m.get(k)?.valor === v) m.delete(k);
    }),
  };
  return { store, m };
}

function relogio() {
  let t = 0;
  const aoDormir: Array<(t: number) => Promise<void> | void> = [];
  return {
    agora: () => t,
    dormir: vi.fn(async (ms: number) => {
      t += ms;
      for (const f of aoDormir) await f(t);
    }),
    aoDormir,
  };
}

const K = '45bc75c9-71fc-46cd-ace6-f3d364f3bb4a:558192205607';

describe('entrarNaFila — caminho comum', () => {
  it('ninguém na frente: pega de primeira, sem esperar e sem dormir', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);

    const vez = await entrarNaFila(store, K, { ttlMs: 120_000, esperaMaxMs: 30_000, agora: r.agora, dormir: r.dormir, gerarToken: () => 'A' });

    expect(vez).toEqual({ token: 'A', esperouMs: 0, concorrente: false });
    expect(store.setNx).toHaveBeenCalledTimes(1);
    expect(store.setNx).toHaveBeenCalledWith(chaveDaFila(K), 'A', 120_000);
    expect(r.dormir).not.toHaveBeenCalled();
  });

  it('esperaMaxMs 0 desliga a fila: nem toca no Redis', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);

    const vez = await entrarNaFila(store, K, { ttlMs: 120_000, esperaMaxMs: 0, agora: r.agora, dormir: r.dormir });

    expect(vez).toEqual({ token: null, esperouMs: 0, concorrente: false });
    expect(store.setNx).not.toHaveBeenCalled();
  });
});

describe('entrarNaFila — dois turnos da mesma conversa', () => {
  it('o 2º só entra depois que o 1º sai (caso 897df853: 2º chegou 5,6 s antes do 1º terminar)', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);
    const opts = { ttlMs: 120_000, esperaMaxMs: 30_000, intervaloMs: 200, agora: r.agora, dormir: r.dormir };

    const primeiro = await entrarNaFila(store, K, { ...opts, gerarToken: () => 'T1' });
    // O 1º termina 5.600 ms depois de o 2º chegar.
    r.aoDormir.push(async (t) => { if (t >= 5_600) await sairDaFila(store, K, primeiro); });

    const segundo = await entrarNaFila(store, K, { ...opts, gerarToken: () => 'T2' });

    expect(segundo.token).toBe('T2');
    expect(segundo.concorrente).toBe(true);
    expect(segundo.esperouMs).toBeGreaterThanOrEqual(5_600);
    expect(segundo.esperouMs).toBeLessThanOrEqual(5_600 + 200);
  });

  it('conversa diferente não espera', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);
    const opts = { ttlMs: 120_000, esperaMaxMs: 30_000, agora: r.agora, dormir: r.dormir };

    await entrarNaFila(store, K, { ...opts, gerarToken: () => 'T1' });
    const outra = await entrarNaFila(store, 'outro-agente:5581999999999', { ...opts, gerarToken: () => 'X' });

    expect(outra).toEqual({ token: 'X', esperouMs: 0, concorrente: false });
  });

  it('espera estourada: segue sem lock (comportamento de antes) e não dorme além do teto', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);
    const opts = { ttlMs: 120_000, esperaMaxMs: 1_000, intervaloMs: 300, agora: r.agora, dormir: r.dormir };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await entrarNaFila(store, K, { ...opts, gerarToken: () => 'T1' }); // nunca solta
    const segundo = await entrarNaFila(store, K, { ...opts, gerarToken: () => 'T2' });

    expect(segundo.token).toBeNull();
    expect(segundo.concorrente).toBe(true);
    expect(segundo.esperouMs).toBe(1_000);
    const dormido = r.dormir.mock.calls.reduce((s, [ms]) => s + ms, 0);
    expect(dormido).toBe(1_000);
  });

  it('turno que morreu sem soltar: o TTL libera e o próximo entra', async () => {
    const r = relogio();
    const { store } = redisEmMemoria(r.agora);
    const opts = { esperaMaxMs: 30_000, intervaloMs: 200, agora: r.agora, dormir: r.dormir };

    await entrarNaFila(store, K, { ...opts, ttlMs: 2_000, gerarToken: () => 'T1' }); // processo caiu
    const segundo = await entrarNaFila(store, K, { ...opts, ttlMs: 120_000, gerarToken: () => 'T2' });

    expect(segundo.token).toBe('T2');
    expect(segundo.esperouMs).toBeGreaterThanOrEqual(2_000);
  });
});

describe('entrarNaFila — Redis fora', () => {
  it('erro no SET: segue sem lock e não derruba o turno', async () => {
    const r = relogio();
    const store: LockStore = {
      setNx: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      delIfEquals: vi.fn(async () => {}),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const vez = await entrarNaFila(store, K, { ttlMs: 120_000, esperaMaxMs: 30_000, agora: r.agora, dormir: r.dormir });

    expect(vez).toEqual({ token: null, esperouMs: 0, concorrente: false });
    await sairDaFila(store, K, vez);
    expect(store.delIfEquals).not.toHaveBeenCalled();
  });
});

describe('sairDaFila', () => {
  it('não solta o lock que já é de outro turno (TTL expirou e o 2º pegou)', async () => {
    const r = relogio();
    const { store, m } = redisEmMemoria(r.agora);
    const opts = { esperaMaxMs: 30_000, intervaloMs: 200, agora: r.agora, dormir: r.dormir };

    const primeiro = await entrarNaFila(store, K, { ...opts, ttlMs: 1_000, gerarToken: () => 'T1' });
    await entrarNaFila(store, K, { ...opts, ttlMs: 120_000, gerarToken: () => 'T2' });
    await sairDaFila(store, K, primeiro); // o 1º, atrasado, tenta soltar

    expect(m.get(chaveDaFila(K))?.valor).toBe('T2');
  });

  it('erro ao soltar não lança (o TTL solta sozinho)', async () => {
    const store: LockStore = {
      setNx: vi.fn(async () => true),
      delIfEquals: vi.fn(async () => { throw new Error('timeout'); }),
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sairDaFila(store, K, { token: 'A', esperouMs: 0, concorrente: false })).resolves.toBeUndefined();
  });
});
