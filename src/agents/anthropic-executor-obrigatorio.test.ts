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

import { tarefasEscritasComoTexto } from './anthropic-executor-obrigatorio';

describe('tarefasEscritasComoTexto', () => {
  it('caso real de 16/10: array de tarefas em bloco json vira tarefas', () => {
    const texto = '```json\n[\n  {"tipo": "CONSULTA", "objetivo": "Buscar valor e datas do Clínico Geral"},\n  {"tipo": "CRM", "objetivo": "Atualizar estágio"}\n]\n```';
    expect(tarefasEscritasComoTexto(texto)).toHaveLength(2);
  });
  it('resposta normal ao cliente não é tarefa', () => {
    expect(tarefasEscritasComoTexto('{"mensagens":["Oi"],"redirect_human":false}')).toBeNull();
    expect(tarefasEscritasComoTexto('Clínico Geral: R$ 85')).toBeNull();
    expect(tarefasEscritasComoTexto('[1, 2]')).toBeNull();
  });
});
