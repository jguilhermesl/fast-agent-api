import { describe, it, expect } from 'vitest';
import { isEmptyPayload, wrap, wrapError } from './envelope';

// Os 6 casos são a tradução 1:1 de public.diag_is_empty_response. Se este teste
// mudar sem a função SQL mudar junto, o painel e o agente passam a discordar
// sobre o que é "resposta vazia".
describe('isEmptyPayload — paridade com diag_is_empty_response', () => {
  const casos: Array<[string, unknown, boolean]> = [
    ['null', null, true],
    ['undefined', undefined, true],
    ['array vazio', [], true],
    ['objeto vazio', {}, true],
    ['string "null"', 'null', true],
    ['string "[]"', '[]', true],
    ['string vazia', '   ', true],
    ['envelope com lista vazia', { available_slots: [] }, true],
    ['envelope com lista cheia', { available_slots: [{ h: '09:00' }] }, false],
    ['array com item', [{ nome: 'Clínico Geral' }], false],
    ['string com texto', 'R$ 85,00', false],
    ['objeto com valor', { success: true }, false],
  ];

  for (const [nome, entrada, esperado] of casos) {
    it(`${nome} -> ${esperado}`, () => {
      expect(isEmptyPayload(entrada)).toBe(esperado);
    });
  }
});

describe('wrap', () => {
  it('marca status=empty e anexa o hint quando o payload é vazio', () => {
    const env = JSON.parse(wrap([], { terms: 'clínico geral' }, 200));
    expect(env.status).toBe('empty');
    expect(env.http_status).toBe(200);
    expect(env.query_echo).toEqual({ terms: 'clínico geral' });
    expect(env.hint).toContain('NÃO afirme que o item não existe');
  });

  it('marca status=ok e não manda hint quando veio dado', () => {
    const env = JSON.parse(wrap([{ nome: 'Clínico Geral' }], { terms: 'clínico geral' }, 200));
    expect(env.status).toBe('ok');
    expect(env.hint).toBeUndefined();
    expect(env.data).toEqual([{ nome: 'Clínico Geral' }]);
  });
});

describe('wrapError', () => {
  it('preserva o status HTTP e o CORPO do erro — que antes iam para o chão', () => {
    const err = {
      message: 'Request failed with status code 400',
      response: { status: 400, data: { error: 'intent_key inválida' } },
    };
    const env = JSON.parse(wrapError(err, { intent_key: 'realizar_agendamento' }));
    expect(env.status).toBe('error');
    expect(env.http_status).toBe(400);
    expect(env.data).toEqual({ error: 'intent_key inválida' });
    expect(env.hint).toContain('NÃO confirme nada ao cliente');
  });

  it('cai para message/code quando não há response', () => {
    const env = JSON.parse(wrapError({ message: 'ECONNRESET', code: 'ECONNRESET' }, { q: 1 }));
    expect(env.status).toBe('error');
    expect(env.http_status).toBeNull();
    expect(env.data).toEqual({ message: 'ECONNRESET', code: 'ECONNRESET' });
  });
});
