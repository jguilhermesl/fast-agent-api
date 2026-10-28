import { describe, it, expect } from 'vitest';
import { intencoesEsquecidas, cobrancaDeTarefas } from './tarefas-esquecidas';

const INTENTS = [
  { name: 'Atualizar ficha no CRM', slug: 'atualizar_ficha' },
  { name: 'Encerrar conversa', slug: 'encerrar_conversa' },
  { name: 'Buscar imóveis no site', slug: 'buscar_imoveis' },
];

// Pedido real do orquestrador no descarte (cenário barato, 27/10/2026).
const DESCARTE = JSON.stringify([
  { tipo: 'AÇÃO', objetivo: "Atualizar ficha no CRM (atualizar_ficha) com etapa perdido e motivo 'Desqualificado: moradia abaixo de R$ 250 mil'" },
  { tipo: 'AÇÃO', objetivo: 'Encerrar conversa', contexto: 'Motivo: Desqualificado: moradia abaixo de R$ 250 mil' },
  { tipo: 'CRM', objetivo: 'Atualizar estágio do painel para desqualificado' },
]);

describe('intencoesEsquecidas', () => {
  it('executor só chamou a ficha: falta o encerramento', () => {
    expect(intencoesEsquecidas(DESCARTE, INTENTS, ['atualizar_ficha']).map((i) => i.slug)).toEqual(['encerrar_conversa']);
  });

  it('tudo chamado: nada falta', () => {
    expect(intencoesEsquecidas(DESCARTE, INTENTS, ['atualizar_ficha', 'encerrar_conversa', 'atualizar_lead_crm'])).toEqual([]);
  });

  it('nada chamado: cobra as duas intenções nomeadas, não a etapa do painel', () => {
    expect(intencoesEsquecidas(DESCARTE, INTENTS, []).map((i) => i.slug)).toEqual(['atualizar_ficha', 'encerrar_conversa']);
  });

  it('objetivo que só cita a intenção sem começar por ela não é cobrado', () => {
    const q = JSON.stringify([{ tipo: 'CONTEXTO', objetivo: 'Registrar contexto sem acionar Encerrar conversa' }]);
    expect(intencoesEsquecidas(q, INTENTS, [])).toEqual([]);
  });

  it('acento e caixa não atrapalham; pelo slug também vale', () => {
    const q = JSON.stringify([{ objetivo: 'BUSCAR IMOVEIS no site: casa até 500 mil' }, { objetivo: 'encerrar_conversa' }]);
    expect(intencoesEsquecidas(q, INTENTS, []).map((i) => i.slug)).toEqual(['buscar_imoveis', 'encerrar_conversa']);
  });

  it('query que não é JSON ou vazia: nada', () => {
    expect(intencoesEsquecidas('Encerrar conversa', INTENTS, [])).toEqual([]);
    expect(intencoesEsquecidas(undefined, INTENTS, [])).toEqual([]);
  });

  it('cobrança cita nome e slug', () => {
    expect(cobrancaDeTarefas([INTENTS[1]])).toContain('"Encerrar conversa" (encerrar_conversa)');
  });
});
