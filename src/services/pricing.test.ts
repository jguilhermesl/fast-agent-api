import { describe, it, expect } from 'vitest';
import { calcCostUsd, inferModelProvider, tarifaDe } from './pricing';

/**
 * Fonte de verdade dos números esperados: a tabela `llm_pricing` do Supabase
 * `ipgewsdujovghxbwisvr`, lida em 28/08/2026. É a mesma tabela que o painel usa
 * para recomputar custo — o gravador tem que concordar com ela, não com uma
 * segunda cópia de preços que ninguém confere.
 *
 *   model_name     input   output   cached   (USD por 1M tokens)
 *   gpt-5.4        2.5     15       0.25
 *   gpt-5.4-mini   0.75    4.5      0.075
 *   gpt-5.2        1.75    14       0.175
 *   gpt-4.1        2       8        0.5
 *   gpt-4.1-mini   0.4     1.6      0.1
 *
 * Contrato de `tokensIn`: **inclui** os cacheados, nos dois provedores. A OpenAI
 * já reporta assim (`prompt_tokens` engloba `cached_tokens`); do lado Anthropic o
 * orquestrador soma `cache_read_input_tokens` em `totalIn` antes de chamar aqui.
 */
const M = 1_000_000;

describe('calcCostUsd — família do modelo', () => {
  it('gpt-5.4-mini com sufixo de data cobra a tarifa do mini, não a do grande', () => {
    // O log grava o nome com data; a tabela de preços guarda a família.
    expect(calcCostUsd('gpt-5.4-mini-2026-03-17', M, 0)).toBeCloseTo(0.75, 6);
  });

  it('gpt-4.1-mini não cai no prefixo de gpt-4.1', () => {
    expect(calcCostUsd('gpt-4.1-mini-2025-04-14', M, 0)).toBeCloseTo(0.4, 6);
  });

  it('gpt-5.4 continua na tarifa cheia', () => {
    expect(calcCostUsd('gpt-5.4-2026-03-05', M, 0)).toBeCloseTo(2.5, 6);
  });

  it('gpt-5.2 continua na tarifa própria', () => {
    expect(calcCostUsd('gpt-5.2-2025-12-11', M, 0)).toBeCloseTo(1.75, 6);
  });

  it('output usa a tarifa de output', () => {
    expect(calcCostUsd('gpt-5.4-mini-2026-03-17', 0, M)).toBeCloseTo(4.5, 6);
  });

  it('modelo desconhecido não zera o custo em silêncio', () => {
    expect(calcCostUsd('modelo-que-nao-existe', M, 0)).toBeGreaterThan(0);
  });
});

describe('calcCostUsd — desconto de tokens cacheados', () => {
  it('input inteiramente cacheado custa a tarifa de cache', () => {
    // 1M cacheado em gpt-5.4-mini: 0.075, não 0.75.
    expect(calcCostUsd('gpt-5.4-mini-2026-03-17', M, 0, M)).toBeCloseTo(0.075, 6);
  });

  it('cache parcial cobra cada fatia na sua tarifa', () => {
    // 74,1% de cache é o que a instrumentação mediu em 28/08/2026.
    // 259_000 * 0.75/1M + 741_000 * 0.075/1M = 0.19425 + 0.055575
    expect(calcCostUsd('gpt-5.4-mini-2026-03-17', M, 0, 741_000)).toBeCloseTo(0.249825, 6);
  });

  it('sem tokens cacheados o resultado é o mesmo de antes', () => {
    expect(calcCostUsd('gpt-5.4-2026-03-05', 500_000, 100_000, 0)).toBeCloseTo(
      calcCostUsd('gpt-5.4-2026-03-05', 500_000, 100_000),
      8
    );
  });

  it('cacheado maior que o input não gera custo negativo', () => {
    // Guarda equivalente ao least(cached, input) das funções SQL.
    expect(calcCostUsd('gpt-5.4-mini-2026-03-17', 1_000, 0, 999_999)).toBeCloseTo(
      0.000075,
      8
    );
  });

  it('modelo sem tarifa de cache cobra o input cheio', () => {
    // Precisa ser um modelo que caia no FALLBACK: todas as 16 famílias da tabela
    // têm `cached`, então usar uma delas nunca exercitaria o ramo
    // `tarifa.cached ?? tarifa.input` — assert que não pode falhar. A primeira
    // versão deste teste usava `claude-sonnet-4-20250514`, que resolve para
    // `claude-sonnet-4` e TEM cache 0,30; media 0,3 e passava por acidente.
    const fallback = calcCostUsd('modelo-que-nao-existe', M, 0, M);
    const semCacheAlgum = calcCostUsd('modelo-que-nao-existe', M, 0, 0);
    expect(fallback).toBeCloseTo(semCacheAlgum, 8);
    expect(fallback).toBeGreaterThan(0);
  });

  it('família conhecida NÃO cai no fallback de cache', () => {
    // Guarda do teste acima: se alguém tirar `cached` de uma família, o desconto
    // some em silêncio e o teste anterior continuaria verde.
    expect(tarifaDe('claude-sonnet-4-20250514').cached).toBeDefined();
    expect(tarifaDe('gpt-5.4-mini-2026-03-17').cached).toBeDefined();
  });
});

describe('inferModelProvider', () => {
  it('reconhece os três provedores em uso', () => {
    expect(inferModelProvider('gpt-5.4-mini-2026-03-17')).toBe('openai');
    expect(inferModelProvider('claude-sonnet-4-6-20260301')).toBe('anthropic');
    expect(inferModelProvider('gemini-2.0-flash')).toBe('gemini');
  });

  it('não chuta provedor para nome desconhecido', () => {
    expect(inferModelProvider('llama-3')).toBe('unknown');
  });
});
