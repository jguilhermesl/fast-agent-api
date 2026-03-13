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

  // Custo por token (ajustar conforme modelos usados)
  tokenCost: {
    'gpt-4.1-mini':       { input: 0.00000015, output: 0.0000006 },
    'gpt-4.1':            { input: 0.000002,   output: 0.000008 },
    'gpt-4o':             { input: 0.0000025,  output: 0.00001 },
    'claude-sonnet-4-5':  { input: 0.000003,   output: 0.000015 },
    'claude-opus-4-5':    { input: 0.000015,   output: 0.000075 },
    'gemini-2.0-flash':   { input: 0.0000001,  output: 0.0000004 },
    'gemini-1.5-pro':     { input: 0.00000125, output: 0.000005 },
  } as Record<string, { input: number; output: number }>,
};
