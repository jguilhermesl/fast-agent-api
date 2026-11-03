import { describe, it, expect } from 'vitest';
import { pedidoDoFallback, pedidoDaReserva, claudeNoOpenRouter, modeloDaChamada, MODELO_FALLBACK_OPENAI } from './fallback-openai';

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

// 03/11/2026, regra do dono: a Duda não gasta OpenAI. Crédito da Anthropic acabou em 28–30/10
// e 166 conversas foram para o gpt-5.4. Agora Anthropic cai no MESMO Claude pelo OpenRouter.
describe('pedidoDaReserva', () => {
  it('Anthropic com chave do OpenRouter: mesmo Claude pelo OpenRouter', () => {
    expect(pedidoDaReserva({ model_provider: 'anthropic', model_name: 'claude-sonnet-5-5' }, true))
      .toEqual({ model_provider: 'openrouter', model_name: 'anthropic/claude-sonnet-5.5' });
  });
  it('sem chave do OpenRouter: comportamento antigo (gpt-5.4)', () => {
    expect(pedidoDaReserva({ model_provider: 'anthropic', model_name: 'claude-sonnet-5-5' }, false))
      .toEqual({ model_provider: 'openai', model_name: MODELO_FALLBACK_OPENAI });
  });
  it('OpenRouter como principal continua caindo na OpenAI (não refaz no próprio OpenRouter)', () => {
    expect(pedidoDaReserva({ model_provider: 'openrouter', model_name: 'x/y' }, true))
      .toEqual({ model_provider: 'openai', model_name: MODELO_FALLBACK_OPENAI });
  });
  it('id do Claude no OpenRouter', () => {
    expect(claudeNoOpenRouter('claude-haiku-5-5')).toBe('anthropic/claude-haiku-5.5');
    expect(claudeNoOpenRouter('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(claudeNoOpenRouter('gpt-5.4')).toBeNull();
  });
  it('modelo e provedor de uma chamada extra depois da reserva (reescrita sem ferramentas)', () => {
    const req = { model_provider: 'anthropic', model_name: 'claude-sonnet-5-5' };
    expect(modeloDaChamada(req, 'anthropic', true)).toEqual({ modelo: 'claude-sonnet-5-5', provedor: 'anthropic' });
    expect(modeloDaChamada(req, 'openrouter', true)).toEqual({ modelo: 'anthropic/claude-sonnet-5.5', provedor: 'openrouter' });
    expect(modeloDaChamada(req, 'openai', true)).toEqual({ modelo: MODELO_FALLBACK_OPENAI, provedor: 'openai' });
  });
});
