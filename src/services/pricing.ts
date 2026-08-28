/**
 * Tarifa dos modelos e cálculo de custo.
 *
 * Mora fora de `supabase.ts` de propósito: aquele módulo cria o cliente
 * service_role no import e `config` exige env var, então nada ali é testável sem
 * subir meio serviço. Preço é aritmética pura e merece um seam próprio.
 *
 * Dois defeitos que este módulo existe para fechar:
 *
 * 1. **Casamento por prefixo na ordem do objeto.** A versão anterior fazia
 *    `Object.entries(tokenCost).find(([k]) => model.startsWith(k))`, e a chave
 *    `gpt-5.4` vinha antes de qualquer `-mini`. Como o log grava o nome com data
 *    (`gpt-5.4-mini-2026-03-17`), todo o tráfego do executor era cobrado na
 *    tarifa do modelo grande — 3,33x a mais, o mesmo fator que a migration
 *    `20260822120000_pricing_mini_e_cache.sql` mediu pelo lado do painel. Aqui o
 *    casamento é pelo **prefixo mais longo**, então `-mini`/`-nano` sempre ganham
 *    do pai, independente da ordem em que forem escritos.
 *
 * 2. **Cache cobrado a preço cheio.** Desde 27/08/2026 o serviço grava
 *    `cached_input_tokens`, e a primeira medição com instrumentação real deu
 *    74,1% do input vindo de cache — que custa ~10% da tarifa. Sem o desconto,
 *    `estimated_cost_usd` superestima quase todo turno.
 *
 * Tarifas em USD por 1.000.000 de tokens.
 *
 * As 10 famílias que EXISTEM em `llm_pricing` (Supabase `ipgewsdujovghxbwisvr`,
 * conferidas linha a linha em 28/08/2026) batem 1:1 com ela — é a tabela que o
 * painel usa para recomputar, então mudou lá, muda aqui. São: gpt-5.4, gpt-5.4-mini,
 * gpt-5.2, gpt-5.2-mini, gpt-4.1, gpt-4.1-mini e as três claude-sonnet-4*.
 *
 * As demais (gpt-4o, gpt-4o-mini, gpt-4.1-nano, claude-opus*, claude-haiku*) NÃO
 * têm linha no `llm_pricing`. Input e output vieram do `config.tokenCost` antigo; o
 * preço de cache segue a razão pública de cada família. Consequência de usá-las: o
 * gravador precifica, mas `diag_month_cost` as conta como `unpriced_calls` e soma
 * zero — gravador e painel divergem. Tráfego nelas em 30 dias: ZERO (20.625
 * chamadas, todas em gpt-5.4-mini / gpt-5.4 / gpt-5.2 / gpt-4.1-mini). Antes de pôr
 * um agente em qualquer uma delas, cadastre a linha em `llm_pricing` primeiro.
 */
export interface Tarifa {
  /** USD por 1M tokens de input não cacheado. */
  input: number;
  /** USD por 1M tokens de output. */
  output: number;
  /** USD por 1M tokens de input lidos do cache. Ausente = sem desconto. */
  cached?: number;
}

export const TARIFAS_POR_1M: Record<string, Tarifa> = {
  // ── OpenAI ────────────────────────────────────────────────
  'gpt-5.4':      { input: 2.5,  output: 15,  cached: 0.25  },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cached: 0.075 },
  'gpt-5.2':      { input: 1.75, output: 14,  cached: 0.175 },
  'gpt-5.2-mini': { input: 0.45, output: 3.5, cached: 0.045 },
  'gpt-4.1':      { input: 2,    output: 8,   cached: 0.5   },
  'gpt-4.1-mini': { input: 0.4,  output: 1.6, cached: 0.1   },
  'gpt-4.1-nano': { input: 0.1,  output: 0.4, cached: 0.025 },
  'gpt-4o':       { input: 2.5,  output: 10,  cached: 1.25  },
  'gpt-4o-mini':  { input: 0.15, output: 0.6, cached: 0.075 },
  // ── Anthropic ─────────────────────────────────────────────
  'claude-opus':     { input: 15,  output: 75, cached: 1.5 },
  'claude-opus-4':   { input: 15,  output: 75, cached: 1.5 },
  'claude-sonnet':   { input: 3,   output: 15, cached: 0.3 },
  'claude-sonnet-4': { input: 3,   output: 15, cached: 0.3 },
  'claude-haiku':    { input: 0.8, output: 4,  cached: 0.08 },
  'claude-haiku-4':  { input: 0.8, output: 4,  cached: 0.08 },
};

/**
 * Tarifa de último recurso. Deliberadamente **não** é zero: um modelo novo tem
 * que aparecer com custo plausível no log em vez de somar zero em silêncio.
 */
const TARIFA_DESCONHECIDA: Tarifa = { input: 1, output: 3 };

/**
 * Resolve a tarifa pelo prefixo **mais longo** que casa com o nome do modelo.
 * `gpt-5.4-mini-2026-03-17` casa `gpt-5.4` e `gpt-5.4-mini`; ganha o segundo.
 */
export function tarifaDe(model: string): Tarifa {
  const exata = TARIFAS_POR_1M[model];
  if (exata) return exata;

  let melhor: Tarifa | undefined;
  let melhorTamanho = -1;
  for (const [chave, tarifa] of Object.entries(TARIFAS_POR_1M)) {
    if (model.startsWith(chave) && chave.length > melhorTamanho) {
      melhor = tarifa;
      melhorTamanho = chave.length;
    }
  }
  return melhor ?? TARIFA_DESCONHECIDA;
}

export function inferModelProvider(modelName: string): string {
  if (modelName.startsWith('gpt') || modelName.startsWith('o1') || modelName.startsWith('o3')) return 'openai';
  if (modelName.startsWith('claude')) return 'anthropic';
  if (modelName.startsWith('gemini')) return 'gemini';
  return 'unknown';
}

/**
 * Custo estimado do turno, em USD.
 *
 * `tokensIn` **inclui** os cacheados nos dois provedores: a OpenAI já reporta
 * assim (`prompt_tokens` engloba `cached_tokens`) e, do lado Anthropic, o
 * orquestrador soma `cache_read_input_tokens` em `totalIn` antes de chamar aqui.
 * O `Math.min` é a mesma guarda do `least(cached, input)` das funções SQL — sem
 * ela, um provedor que mude a semântica produziria custo negativo.
 */
export function calcCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensCached = 0
): number {
  const tarifa = tarifaDe(model);
  const cacheados = Math.max(0, Math.min(tokensCached, tokensIn));
  const cheios = tokensIn - cacheados;
  const precoCache = tarifa.cached ?? tarifa.input;

  const usd =
    (cheios * tarifa.input + cacheados * precoCache + tokensOut * tarifa.output) / 1_000_000;

  return parseFloat(usd.toFixed(8));
}
