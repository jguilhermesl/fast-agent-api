// ============================================================
// Teste de calcCostUsd — contabilidade de token
// ============================================================
//
//   npx tsx scripts/test-custo.ts
//
// `calcCostUsd` alimenta `llm_usage_logs.estimated_cost_usd`, que é o número que
// a operação usa para decidir modelo e prompt. Erro aqui não quebra atendimento
// — mente sobre dinheiro, que é pior de descobrir.
//
// O foco é não-regressão: com `cachedIn = 0` o resultado tem de ser byte a byte
// o de antes do parâmetro existir.

process.env.API_SECRET = 'test';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.WEBHOOK_SECRET = 'test';

// require em vez de import estático: `config` valida as env vars no topo do
// módulo, e elas precisam estar postas antes da carga.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { calcCostUsd, inferModelProvider } = require('../src/services/supabase') as
  typeof import('../src/services/supabase');

let passou = 0;
let falhou = 0;

function check(nome: string, real: unknown, esperado: unknown) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    passou++;
    console.log(`  ok   ${nome}`);
  } else {
    falhou++;
    console.log(`  FALHA ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        real:     ${JSON.stringify(real)}`);
  }
}

// Preços de config/index.ts, por token.
const GPT54_IN = 0.0000025;
const GPT54_OUT = 0.000015;

console.log('\n[1] Sem cache — resultado idêntico ao cálculo anterior (não-regressão)');

const semCache = (tin: number, tout: number, rin: number, rout: number) =>
  parseFloat(((tin * rin) + (tout * rout)).toFixed(8));

check('gpt-5.4, 22425 in / 168 out',
  calcCostUsd('gpt-5.4', 22425, 168), semCache(22425, 168, GPT54_IN, GPT54_OUT));
check('argumento cachedIn omitido == cachedIn 0',
  calcCostUsd('gpt-5.4', 22425, 168), calcCostUsd('gpt-5.4', 22425, 168, 0));
check('zero tokens',
  calcCostUsd('gpt-5.4', 0, 0), 0);
check('modelo desconhecido cai no fallback',
  calcCostUsd('modelo-que-nao-existe', 1_000_000, 0), 1);
check('match por prefixo (gpt-4.1-mini-2025-04-14)',
  calcCostUsd('gpt-4.1-mini-2025-04-14', 1_000_000, 0), 0.4);
check('Anthropic segue idêntico (provider não devolve cached_tokens)',
  calcCostUsd('claude-sonnet-5-20260101', 1_000_000, 0), 3);

console.log('\n[2] Com cache — parcela cacheada a 10% do input');

check('metade cacheada: 500k cheios + 500k a 10%',
  calcCostUsd('gpt-5.4', 1_000_000, 0, 500_000),
  parseFloat(((500_000 * GPT54_IN) + (500_000 * GPT54_IN * 0.1)).toFixed(8)));
check('tudo cacheado custa 10% do total',
  calcCostUsd('gpt-5.4', 1_000_000, 0, 1_000_000),
  parseFloat((1_000_000 * GPT54_IN * 0.1).toFixed(8)));
check('cache nunca aumenta o custo',
  calcCostUsd('gpt-5.4', 22425, 168, 9856) < calcCostUsd('gpt-5.4', 22425, 168), true);
check('output não é afetado pelo cache',
  calcCostUsd('gpt-5.4', 0, 1000, 0), calcCostUsd('gpt-5.4', 0, 1000, 500));

console.log('\n[3] Valores absurdos não viram custo negativo nem inflado');

check('cachedIn maior que tokensIn é clampado',
  calcCostUsd('gpt-5.4', 1000, 0, 999_999), calcCostUsd('gpt-5.4', 1000, 0, 1000));
check('cachedIn negativo é clampado em 0',
  calcCostUsd('gpt-5.4', 1000, 0, -500), calcCostUsd('gpt-5.4', 1000, 0, 0));
check('nunca negativo',
  calcCostUsd('gpt-5.4', 1000, 100, 999_999) >= 0, true);

console.log('\n[4] Prefixo mais longo vence — o bug que inflava o custo dos "mini"');

check('gpt-4.1-mini-* usa a tarifa do mini, não a do gpt-4.1',
  calcCostUsd('gpt-4.1-mini-2025-04-14', 16233, 215),
  parseFloat(((16233 * 0.0000004) + (215 * 0.0000016)).toFixed(8)));
check('gpt-4.1-nano-* usa a tarifa do nano',
  calcCostUsd('gpt-4.1-nano-2025-04-14', 1_000_000, 0), 0.1);
check('gpt-4.1 sem sufixo continua no preço cheio',
  calcCostUsd('gpt-4.1-2025-04-14', 1_000_000, 0), 2);
check('gpt-4o-mini não vira gpt-4o',
  calcCostUsd('gpt-4o-mini-2024-07-18', 1_000_000, 0), 0.15);
check('claude-sonnet-4-5-20251001 casa o prefixo sonnet',
  calcCostUsd('claude-sonnet-4-5-20251001', 1_000_000, 0), 3);
check('claude-haiku-* não vira sonnet',
  calcCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0), 0.8);

console.log('\n[5] inferModelProvider');

check('gpt-5.4', inferModelProvider('gpt-5.4'), 'openai');
check('claude-sonnet-5', inferModelProvider('claude-sonnet-5'), 'anthropic');
check('gemini-2.5', inferModelProvider('gemini-2.5-pro'), 'gemini');
check('desconhecido', inferModelProvider('llama-4'), 'unknown');

console.log(`\n${'─'.repeat(52)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);

