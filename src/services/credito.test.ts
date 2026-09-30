import { describe, it, expect } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { ehErroDeCredito, deveUsarReserva } from './credito';
import { DeadlineExceededError } from './deadline';

// Os erros são montados com as classes REAIS dos SDKs instalados (`APIError.generate`,
// o mesmo caminho que o SDK usa ao receber a resposta HTTP), para o teste quebrar se
// uma versão nova mudar o formato do erro.
// `Headers` do SDK é um Record simples, não o `Headers` do fetch.
const h = {};
const openaiErro = (status: number, body: Record<string, unknown>) =>
  OpenAI.APIError.generate(status, { error: body }, undefined, h);
const anthropicErro = (status: number, body: Record<string, unknown>) =>
  Anthropic.APIError.generate(status, body, undefined, h);

describe('ehErroDeCredito', () => {
  it('429 sem crédito, formato real de 02/09 e 29/09/2026 (credit_balance_exhausted)', () => {
    const err = openaiErro(429, {
      message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      type: 'insufficient_quota',
      code: 'credit_balance_exhausted',
    });
    // A mensagem gravada em agent_error_logs é exatamente esta:
    expect(err.message).toMatch(/^429 You have no credits remaining/);
    expect(ehErroDeCredito(err)).toBe(true);
  });

  it('429 insufficient_quota (formato antigo "exceeded your current quota")', () => {
    const err = openaiErro(429, {
      message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
    });
    expect(ehErroDeCredito(err)).toBe(true);
  });

  it('reconhece só pela mensagem quando code/type não vêm (erro reembrulhado)', () => {
    expect(ehErroDeCredito(new Error('429 You have no credits remaining. Add credits to continue'))).toBe(true);
  });

  it('Anthropic sem saldo: 400 "credit balance is too low"', () => {
    const err = anthropicErro(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    });
    expect(ehErroDeCredito(err)).toBe(true);
  });

  it('429 de rate limit comum NÃO é crédito', () => {
    const err = openaiErro(429, {
      message: 'Rate limit reached for gpt-5.4 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    });
    expect(ehErroDeCredito(err)).toBe(false);
  });

  it('5xx, timeout, 400 de parâmetro e 401 NÃO são crédito', () => {
    expect(ehErroDeCredito(openaiErro(500, { message: 'The server had an error while processing your request.', type: 'server_error' }))).toBe(false);
    expect(ehErroDeCredito(new OpenAI.APIConnectionTimeoutError())).toBe(false);
    expect(ehErroDeCredito(openaiErro(400, {
      message: 'Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions.',
      type: 'invalid_request_error',
    }))).toBe(false);
    expect(ehErroDeCredito(anthropicErro(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))).toBe(false);
  });

  it('DeadlineExceededError nunca é crédito, mesmo com texto parecido', () => {
    expect(ehErroDeCredito(new DeadlineExceededError('no credits remaining'))).toBe(false);
  });

  it('não-Error nunca é crédito', () => {
    expect(ehErroDeCredito('429 You have no credits remaining')).toBe(false);
    expect(ehErroDeCredito({ code: 'insufficient_quota' })).toBe(false);
    expect(ehErroDeCredito(undefined)).toBe(false);
    expect(ehErroDeCredito(null)).toBe(false);
  });
});

describe('deveUsarReserva', () => {
  const credito = openaiErro(429, { message: 'You have no credits remaining.', type: 'insufficient_quota', code: 'credit_balance_exhausted' });
  const base = { provider: 'openai', err: credito, habilitado: true, temChave: true };

  it('agente openai + erro de crédito + ligado + com chave → usa reserva', () => {
    expect(deveUsarReserva(base)).toBe(true);
  });

  it('desligado por FALLBACK_CREDITO=off → não usa', () => {
    expect(deveUsarReserva({ ...base, habilitado: false })).toBe(false);
  });

  it('sem chave Anthropic → não usa', () => {
    expect(deveUsarReserva({ ...base, temChave: false })).toBe(false);
  });

  it('agente anthropic → não usa (esse caminho já tem o fallback inverso para a OpenAI)', () => {
    expect(deveUsarReserva({ ...base, provider: 'anthropic' })).toBe(false);
  });

  it('erro que não é de crédito → não usa', () => {
    expect(deveUsarReserva({ ...base, err: openaiErro(429, { message: 'Rate limit reached', code: 'rate_limit_exceeded' }) })).toBe(false);
  });
});
