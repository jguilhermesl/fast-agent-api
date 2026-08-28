import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDeadline, capTimeout, DeadlineExceededError } from './deadline';

afterEach(() => {
  vi.useRealTimers();
});

describe('createDeadline', () => {
  it('não expira antes do orçamento acabar', () => {
    const d = createDeadline(1_000);
    expect(d.expired()).toBe(false);
    expect(d.remaining()).toBeGreaterThan(0);
  });

  it('expira depois que o orçamento passa', () => {
    vi.useFakeTimers();
    const d = createDeadline(1_000);
    vi.advanceTimersByTime(1_001);
    expect(d.expired()).toBe(true);
    expect(d.remaining()).toBeLessThanOrEqual(0);
  });
});

describe('capTimeout', () => {
  it('sem deadline, devolve o teto original — chamador sem orçamento agregado não muda', () => {
    expect(capTimeout(60_000)).toBe(60_000);
  });

  it('com bastante orçamento sobrando, devolve o teto original', () => {
    const d = createDeadline(120_000);
    expect(capTimeout(60_000, d)).toBe(60_000);
  });

  it('com pouco orçamento sobrando, encolhe o timeout pro que resta', () => {
    const d = createDeadline(5_000);
    expect(capTimeout(60_000, d)).toBeLessThanOrEqual(5_000);
  });

  it('nunca devolve menos que 1s, nem com orçamento já estourado (timeout=0 trava a lib HTTP)', () => {
    vi.useFakeTimers();
    const d = createDeadline(100);
    vi.advanceTimersByTime(200);
    expect(capTimeout(60_000, d)).toBe(1_000);
  });
});

describe('DeadlineExceededError', () => {
  it('carrega onde estourou, pra log distinguir de erro de provider', () => {
    const err = new DeadlineExceededError('executor round 3');
    expect(err.name).toBe('DeadlineExceededError');
    expect(err.message).toContain('executor round 3');
  });
});
