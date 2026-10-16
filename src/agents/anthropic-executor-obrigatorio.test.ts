import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { comLembrete, ehRecusaDeFerramentaForcada, LEMBRETE_EXECUTOR } from './anthropic-executor-obrigatorio';

describe('executor obrigatório na Anthropic', () => {
  it('o lembrete vai como bloco a mais no fim da mensagem do cliente, sem mexer no original', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'assistant', content: 'oi' }, { role: 'user', content: 'quanto é o ortopedista?' }];
    const com = comLembrete(msgs, LEMBRETE_EXECUTOR);
    expect(com[1].content).toEqual([
      { type: 'text', text: 'quanto é o ortopedista?' },
      { type: 'text', text: LEMBRETE_EXECUTOR },
    ]);
    expect(msgs[1].content).toBe('quanto é o ortopedista?');
    expect(com[0]).toEqual(msgs[0]);
  });

  it('reconhece o 400 real do claude-sonnet-5-5 (16/10/2026)', () => {
    const erro = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}'), { status: 400 });
    expect(ehRecusaDeFerramentaForcada(erro)).toBe(true);
  });

  it('não confunde com outros erros', () => {
    expect(ehRecusaDeFerramentaForcada(Object.assign(new Error('401 invalid x-api-key'), { status: 401 }))).toBe(false);
    expect(ehRecusaDeFerramentaForcada(Object.assign(new Error('400 max_tokens too large'), { status: 400 }))).toBe(false);
    expect(ehRecusaDeFerramentaForcada(Object.assign(new Error('529 overloaded tool_choice not supported'), { status: 529 }))).toBe(false);
  });
});
