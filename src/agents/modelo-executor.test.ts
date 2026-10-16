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
