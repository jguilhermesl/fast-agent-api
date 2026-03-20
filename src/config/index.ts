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

  // Custo por token — valores em USD por token (preço/1.000.000)
  // Fonte: openai.com/api/pricing + anthropic.com/pricing (março 2026)
  tokenCost: {
    // ── OpenAI ────────────────────────────────────────────────
    'gpt-5.4':            { input: 0.0000025,   output: 0.000015   },  // $2.50 / $15.00 per 1M
    'gpt-5.2':            { input: 0.00000175,  output: 0.000014   },  // $1.75 / $14.00 per 1M
    'gpt-4.1':            { input: 0.000002,    output: 0.000008   },  // $2.00 / $8.00 per 1M
    'gpt-4.1-mini':       { input: 0.0000004,   output: 0.0000016  },  // $0.40 / $1.60 per 1M
    'gpt-4.1-nano':       { input: 0.0000001,   output: 0.0000004  },  // $0.10 / $0.40 per 1M
    'gpt-4o':             { input: 0.0000025,   output: 0.00001    },  // $2.50 / $10.00 per 1M
    'gpt-4o-mini':        { input: 0.00000015,  output: 0.0000006  },  // $0.15 / $0.60 per 1M
    // ── Anthropic ─────────────────────────────────────────────
    'claude-opus-4':              { input: 0.000015,    output: 0.000075   },  // $15.00 / $75.00 per 1M
    'claude-sonnet-4':            { input: 0.000003,    output: 0.000015   },  // $3.00 / $15.00 per 1M
    'claude-haiku-4':             { input: 0.0000008,   output: 0.000004   },  // $0.80 / $4.00 per 1M
    // versões com data explícita
    'claude-sonnet-4-6-20260301': { input: 0.000003,    output: 0.000015   },  // $3.00 / $15.00 per 1M
    'claude-sonnet-4-5-20260201': { input: 0.000003,    output: 0.000015   },  // $3.00 / $15.00 per 1M
    // prefixos para capturar versões com data (ex: claude-sonnet-4-5-20251001)
    'claude-opus':                { input: 0.000015,    output: 0.000075   },
    'claude-sonnet':              { input: 0.000003,    output: 0.000015   },
    'claude-haiku':               { input: 0.0000008,   output: 0.000004   },
  } as Record<string, { input: number; output: number }>,
};
