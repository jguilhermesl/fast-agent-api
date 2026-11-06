import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { comLembrete, ehRecusaDeFerramentaForcada, LEMBRETE_EXECUTOR, LEMBRETE_EXECUTOR_FIRME, LEMBRETE_EXECUTOR_OPCIONAL, decidirRodada0, rodada0OpenAI, tarefasVazias, textoJuntoDaChamadaVazia } from './anthropic-executor-obrigatorio';

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

// 04/11/2026, Duda: com o lembrete obrigatório o Sonnet inventava tarefa para cumprir a regra
// ("CRM: atualizar estágio" num "Boa tarde", "CONTEXTO: analisar" num "obrigada, até amanhã"):
// 34% dos turnos pagavam 2 rodadas para responder do histórico. `executor_opcional` troca o
// lembrete obrigatório por um que deixa responder direto quando não há o que buscar.
describe('decidirRodada0', () => {
  const base = { round: 0, dispensa: false, opcional: false, aceitaForcada: false, firmeUsado: false };
  it('padrão (sem a chave): igual ao de antes — obrigatório com lembrete', () => {
    expect(decidirRodada0(base)).toEqual({ obrigatorio: true, forcar: false, lembrete: LEMBRETE_EXECUTOR });
    expect(decidirRodada0({ ...base, firmeUsado: true }).lembrete).toBe(LEMBRETE_EXECUTOR_FIRME);
    expect(decidirRodada0({ ...base, aceitaForcada: true })).toEqual({ obrigatorio: true, forcar: true, lembrete: null });
  });
  it('com executor_opcional: não obriga e manda o lembrete opcional', () => {
    expect(decidirRodada0({ ...base, opcional: true })).toEqual({ obrigatorio: false, forcar: false, lembrete: LEMBRETE_EXECUTOR_OPCIONAL });
    expect(decidirRodada0({ ...base, opcional: true, aceitaForcada: true })).toEqual({ obrigatorio: false, forcar: false, lembrete: LEMBRETE_EXECUTOR_OPCIONAL });
  });
  it('cumprimento/confirmação (dispensa) e rodadas seguintes: nada, com ou sem a chave', () => {
    expect(decidirRodada0({ ...base, dispensa: true })).toEqual({ obrigatorio: false, forcar: false, lembrete: null });
    expect(decidirRodada0({ ...base, dispensa: true, opcional: true })).toEqual({ obrigatorio: false, forcar: false, lembrete: null });
    expect(decidirRodada0({ ...base, round: 1, opcional: true })).toEqual({ obrigatorio: false, forcar: false, lembrete: null });
  });
  it('o lembrete opcional proíbe chamar só para o CRM e mantém valor/data presos ao executor', () => {
    expect(LEMBRETE_EXECUTOR_OPCIONAL).toMatch(/CRM/);
    expect(LEMBRETE_EXECUTOR_OPCIONAL).toMatch(/[Vv]alor e data/);
  });
});

// 04/11/2026: Leandro (gpt-5.4): 38% dos turnos eram "só CRM" e 12% chamavam o executor à toa,
// por causa do tool_choice 'required' na rodada 0. A mesma chave vale no caminho OpenAI.
describe('rodada0OpenAI', () => {
  it('padrão: required na rodada 0, sem lembrete', () => {
    expect(rodada0OpenAI({ round: 0, dispensa: false, opcional: false })).toEqual({ toolChoice: 'required', lembrete: null });
  });
  it('com executor_opcional: auto + lembrete opcional', () => {
    expect(rodada0OpenAI({ round: 0, dispensa: false, opcional: true })).toEqual({ toolChoice: 'auto', lembrete: LEMBRETE_EXECUTOR_OPCIONAL });
  });
  it('cumprimento ou rodadas seguintes: auto, sem lembrete', () => {
    expect(rodada0OpenAI({ round: 0, dispensa: true, opcional: true })).toEqual({ toolChoice: 'auto', lembrete: null });
    expect(rodada0OpenAI({ round: 1, dispensa: false, opcional: false })).toEqual({ toolChoice: 'auto', lembrete: null });
  });
});

// 06/11/2026, Duda: 22% dos turnos (149 de 673 em 48 h) chamavam chamar_executor com tasks: [],
// o código rodava o executor mesmo assim e o ciclo ia a 3,4 rodadas em média (geral 1,9).
describe('chamada vazia ao executor', () => {
  it('tasks vazio, ausente ou não-array é vazio; com tarefa não é', () => {
    expect(tarefasVazias({ tasks: [] })).toBe(true);
    expect(tarefasVazias({})).toBe(true);
    expect(tarefasVazias({ tasks: 'x' })).toBe(true);
    expect(tarefasVazias({ tasks: [{ tipo: 'CONSULTA', objetivo: 'valor' }] })).toBe(false);
  });
  it('resposta pronta junto da chamada vazia é aproveitada; texto vazio não', () => {
    expect(textoJuntoDaChamadaVazia([{ type: 'text', text: '{"mensagens":["Oi"]}' }, { type: 'tool_use', input: { tasks: [] } }])).toBe('{"mensagens":["Oi"]}');
    expect(textoJuntoDaChamadaVazia([{ type: 'text', text: '  ' }, { type: 'tool_use', input: { tasks: [] } }])).toBeNull();
    expect(textoJuntoDaChamadaVazia([{ type: 'text', text: 'Vou verificar.' }, { type: 'tool_use', input: { tasks: [] } }])).toBeNull();
    expect(textoJuntoDaChamadaVazia([{ type: 'tool_use', input: { tasks: [{ tipo: 'CONSULTA' }] } }])).toBeNull();
  });
});
