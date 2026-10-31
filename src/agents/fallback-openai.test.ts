import { describe, it, expect } from 'vitest';
import { pedidoDoFallback, MODELO_FALLBACK_OPENAI } from './fallback-openai';

describe('pedidoDoFallback', () => {
  it('troca provedor E modelo: o fallback do OpenRouter vai para a OpenAI, não para o próprio OpenRouter', () => {
    const req = { model_provider: 'openrouter', model_name: 'deepseek/deepseek-v4.1-flash', agent_id: 'x' };
    expect(pedidoDoFallback(req)).toEqual({ model_provider: 'openai', model_name: 'gpt-5.4', agent_id: 'x' });
  });

  it('Anthropic também cai na OpenAI com o gpt-5.4', () => {
    const r = pedidoDoFallback({ model_provider: 'anthropic', model_name: 'claude-sonnet-5-5' });
    expect(r).toEqual({ model_provider: 'openai', model_name: MODELO_FALLBACK_OPENAI });
  });

  it('não altera o pedido original', () => {
    const req = { model_provider: 'openrouter', model_name: 'openai/gpt-6-luna' };
    pedidoDoFallback(req);
    expect(req.model_provider).toBe('openrouter');
  });
});
