import { describe, it, expect } from 'vitest';
import { escolherModeloExecutor, modeloExecutorAceito, MODELO_EXECUTOR_PADRAO } from './modelo-executor';

describe('escolherModeloExecutor', () => {
  it('sem nada configurado, fica no gpt-5.4-mini de sempre', () => {
    expect(escolherModeloExecutor({})).toBe('gpt-5.4-mini');
    expect(MODELO_EXECUTOR_PADRAO).toBe('gpt-5.4-mini');
  });

  it('usa o modelo do agente quando ele é aceito', () => {
    expect(escolherModeloExecutor({ doAgente: 'gpt-6-luna' })).toBe('gpt-6-luna');
  });

  it('aceita os Claude 5.5 no Executor (caminho claude-* de executor.ts)', () => {
    expect(escolherModeloExecutor({ doAgente: 'claude-haiku-5-5' })).toBe('claude-haiku-5-5');
    expect(escolherModeloExecutor({ doCorpo: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5');
  });

  it('o corpo da requisição (suíte) passa na frente do agente', () => {
    expect(escolherModeloExecutor({ doCorpo: 'gpt-5.6-luna', doAgente: 'gpt-6-luna' })).toBe('gpt-5.6-luna');
  });

  it('nome desconhecido não chega na OpenAI: cai para o próximo da ordem', () => {
    expect(escolherModeloExecutor({ doCorpo: 'gpt-6-lua', doAgente: 'gpt-6-luna' })).toBe('gpt-6-luna');
    expect(escolherModeloExecutor({ doAgente: 'gpt-6.1-sol' })).toBe('gpt-5.4-mini');
    expect(escolherModeloExecutor({ doAgente: 'claude-haiku-5.5' })).toBe('gpt-5.4-mini');
  });

  it('ignora valor que não é texto e espaço sobrando', () => {
    expect(escolherModeloExecutor({ doAgente: 42 })).toBe('gpt-5.4-mini');
    expect(escolherModeloExecutor({ doAgente: null, doCorpo: undefined })).toBe('gpt-5.4-mini');
    expect(escolherModeloExecutor({ doAgente: ' gpt-6-luna ' })).toBe('gpt-6-luna');
  });
});

describe('modeloExecutorAceito', () => {
  it('aceita a versão com data e recusa sufixo que não é data', () => {
    expect(modeloExecutorAceito('gpt-6-luna-2026-09-22')).toBe(true);
    expect(modeloExecutorAceito('gpt-5.4-mini-2026-03-17')).toBe(true);
    expect(modeloExecutorAceito('gpt-6-luna-pro')).toBe(false);
    expect(modeloExecutorAceito('gpt-5.4-pro')).toBe(false);
  });
});

describe('modelo do executor pelo OpenRouter (31/10/2026)', () => {
  it('aceita id fornecedor/modelo só quando o serviço tem a chave', () => {
    expect(escolherModeloExecutor({ doAgente: 'openai/gpt-6-luna', aceitaOpenRouter: true })).toBe('openai/gpt-6-luna');
    expect(escolherModeloExecutor({ doAgente: 'deepseek/deepseek-v4.1-flash', aceitaOpenRouter: true })).toBe('deepseek/deepseek-v4.1-flash');
    expect(escolherModeloExecutor({ doAgente: 'openai/gpt-6-luna' })).toBe('gpt-5.4-mini');
    expect(escolherModeloExecutor({ doAgente: 'openai/gpt-6-luna', aceitaOpenRouter: false })).toBe('gpt-5.4-mini');
  });

  it('id torto não passa nem com a chave', () => {
    expect(escolherModeloExecutor({ doAgente: 'openai/', aceitaOpenRouter: true })).toBe('gpt-5.4-mini');
    expect(escolherModeloExecutor({ doAgente: 'a/b/c', aceitaOpenRouter: true })).toBe('gpt-5.4-mini');
  });

  it('a lista de sempre continua valendo com a chave ligada', () => {
    expect(escolherModeloExecutor({ doAgente: 'claude-haiku-5-5', aceitaOpenRouter: true })).toBe('claude-haiku-5-5');
    expect(modeloExecutorAceito('gpt-6-luna', true)).toBe(true);
  });
});
