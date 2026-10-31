import { describe, it, expect } from 'vitest';
import {
  ehModeloOpenRouter,
  semFornecedor,
  extrasOpenRouter,
  custoDoOpenRouter,
  somarCusto,
  mensagensParaOpenRouter,
  criarClienteOpenRouter,
} from './openrouter';

describe('ehModeloOpenRouter', () => {
  it('reconhece id fornecedor/modelo', () => {
    expect(ehModeloOpenRouter('openai/gpt-6-luna')).toBe(true);
    expect(ehModeloOpenRouter('deepseek/deepseek-v4.1-flash')).toBe(true);
    expect(ehModeloOpenRouter('anthropic/claude-haiku-5.5')).toBe(true);
    expect(ehModeloOpenRouter('moonshotai/kimi-k3.1-pro:batch')).toBe(true);
  });

  it('nome direto da OpenAI ou da Anthropic não é OpenRouter', () => {
    expect(ehModeloOpenRouter('gpt-5.4-mini')).toBe(false);
    expect(ehModeloOpenRouter('claude-haiku-5-5')).toBe(false);
    expect(ehModeloOpenRouter('gpt-6-luna-2026-09-22')).toBe(false);
  });

  it('recusa texto torto', () => {
    expect(ehModeloOpenRouter('openai/')).toBe(false);
    expect(ehModeloOpenRouter('/gpt-6-luna')).toBe(false);
    expect(ehModeloOpenRouter('a/b/c')).toBe(false);
    expect(ehModeloOpenRouter('openai/gpt 6')).toBe(false);
    expect(ehModeloOpenRouter('')).toBe(false);
  });
});

describe('semFornecedor', () => {
  it('tira o fornecedor e deixa o resto igual', () => {
    expect(semFornecedor('openai/gpt-6-luna')).toBe('gpt-6-luna');
    expect(semFornecedor('gpt-5.4')).toBe('gpt-5.4');
  });
});

describe('extrasOpenRouter', () => {
  it('nega coleta de dados e pede o custo real', () => {
    expect(extrasOpenRouter()).toEqual({ provider: { data_collection: 'deny' }, usage: { include: true } });
  });
});

describe('custoDoOpenRouter e somarCusto', () => {
  it('lê usage.cost só quando é número válido', () => {
    expect(custoDoOpenRouter({ cost: 0.0012 })).toBe(0.0012);
    expect(custoDoOpenRouter({ cost: 0 })).toBe(0);
    expect(custoDoOpenRouter({ cost: '0.1' })).toBeUndefined();
    expect(custoDoOpenRouter({ cost: -1 })).toBeUndefined();
    expect(custoDoOpenRouter({})).toBeUndefined();
    expect(custoDoOpenRouter(undefined)).toBeUndefined();
  });

  it('uma rodada sem custo invalida o turno inteiro', () => {
    let total: number | null = 0;
    total = somarCusto(total, 0.001);
    total = somarCusto(total, 0.002);
    expect(total).toBeCloseTo(0.003, 10);
    expect(somarCusto(total, undefined)).toBeNull();
    expect(somarCusto(null, 0.5)).toBeNull();
  });
});

describe('mensagensParaOpenRouter', () => {
  const msgs = [
    { role: 'system' as const, content: 'persona fixa' },
    { role: 'user' as const, content: 'oi' },
  ];

  it('marca o system com cache_control só para modelo da Anthropic', () => {
    const r = mensagensParaOpenRouter('anthropic/claude-sonnet-5.5', msgs);
    expect(r[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'persona fixa', cache_control: { type: 'ephemeral' } }] });
    expect(r[1]).toEqual(msgs[1]);
  });

  it('os outros modelos recebem as mensagens como estão', () => {
    expect(mensagensParaOpenRouter('openai/gpt-6-luna', msgs)).toBe(msgs);
    expect(mensagensParaOpenRouter('deepseek/deepseek-v4.1-flash', msgs)).toBe(msgs);
  });
});

describe('criarClienteOpenRouter', () => {
  it('sem chave não cria cliente', () => {
    expect(criarClienteOpenRouter('', 1000)).toBeNull();
  });

  it('com chave aponta para o OpenRouter', () => {
    const c = criarClienteOpenRouter('sk-or-teste', 1000);
    expect(c?.baseURL).toBe('https://openrouter.ai/api/v1');
  });
});
