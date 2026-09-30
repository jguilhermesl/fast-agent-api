import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiSecret: required('API_SECRET'),

  openaiApiKey: required('OPENAI_API_KEY'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  // googleApiKey: required('GOOGLE_API_KEY'),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),

  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  webhookSecret: required('WEBHOOK_SECRET'),

  // Z-API partner/client token (required as Client-Token header for all Z-API requests)
  zapiClientToken: process.env.ZAPI_CLIENT_TOKEN ?? '',

  // Guard de grounding (src/agents/guard.ts). `shadow` só grava o veredito em
  // guard_shadow_logs e deixa a resposta passar; `enforce` reescreve a resposta.
  // É env var e não constante de propósito: desarmar o enforce em produção tem
  // que levar segundos, sem redeploy. Nunca ligar `enforce` sem os 7 dias de
  // shadow calibrados (SPEC-02 §7).
  guardMode: (process.env.GUARD_MODE === 'enforce' ? 'enforce' : 'shadow') as 'shadow' | 'enforce',

  // Mensagem cruzada (src/agents/cruzamento.ts). `nota` avisa o modelo que o
  // cliente escreveu antes de receber a resposta anterior; `log` só detecta e
  // loga; `off` nem consulta. Env var pelo mesmo motivo do GUARD_MODE: voltar
  // atrás em produção tem que levar segundos, sem redeploy.
  cruzamentoMode: (['log', 'off'].includes(process.env.CRUZAMENTO_MODE ?? '')
    ? process.env.CRUZAMENTO_MODE
    : 'nota') as 'nota' | 'log' | 'off',

  // Reserva quando o crédito da OpenAI zera (services/credito.ts): o turno de um
  // agente `openai` é refeito na Anthropic, Orquestrador e Executor. Liga por
  // padrão; `FALLBACK_CREDITO=off` desliga sem redeploy (mesmo motivo do
  // GUARD_MODE). Sem `ANTHROPIC_API_KEY` válida a reserva falha em ~0,3 s e o
  // turno cai no fallback de segurança de sempre — nada piora.
  fallbackCredito: (process.env.FALLBACK_CREDITO === 'off' ? 'off' : 'on') as 'on' | 'off',
  // `claude-sonnet-4-6` é o ID que já roda no n8n (nó "Anthropic Chat Model" do
  // AGENTE BASE, mesma conta). O equivalente natural do `gpt-5.4-mini` no Executor
  // seria um Haiku, mas nenhum ID de Haiku foi verificado nesta conta: numa
  // emergência, ID que responde vale mais que tarifa. Trocar é só env var.
  fallbackAnthropicModel: process.env.FALLBACK_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  fallbackAnthropicExecutorModel: process.env.FALLBACK_ANTHROPIC_EXECUTOR_MODEL || 'claude-sonnet-4-6',

  // A tabela de tarifas saiu daqui para `src/services/pricing.ts`, que espelha o
  // `llm_pricing` do Supabase e roda em teste sem env var. Enquanto morava neste
  // objeto, `gpt-5.4-mini` era cobrado na tarifa do `gpt-5.4` e ninguém tinha
  // como provar o contrário sem subir o serviço inteiro.
};
