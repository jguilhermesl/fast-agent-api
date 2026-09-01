import { describe, it, expect } from 'vitest';
import { afirmaAgendamento, criouEventoNesteTurno } from './agendamento-guard';
import type { ToolCallLog } from '../types';

const chamada = (tool: string, result: unknown): ToolCallLog => ({ tool, arguments: {}, result });

describe('criouEventoNesteTurno — leitura do envelope', () => {
  it('envelope status=error NÃO conta como evento criado', () => {
    // Sem o ramo de envelope, este objeto passaria como sucesso: não tem
    // `success:false` nem `error` no topo. O guard voltaria a achar que o evento
    // existe quando a intenção falhou.
    const envelope = {
      status: 'error',
      http_status: 400,
      data: { message: 'data invalida' },
      query_echo: { intent_key: 'realizar_agendamento' },
    };
    expect(criouEventoNesteTurno([chamada('realizar_agendamento', envelope)])).toBe(false);
  });

  it('envelope status=empty NÃO conta como evento criado', () => {
    const envelope = { status: 'empty', http_status: 200, data: [], query_echo: {} };
    expect(criouEventoNesteTurno([chamada('google_calendar_criar_evento', envelope)])).toBe(false);
  });

  it('envelope status=ok com dado conta como evento criado', () => {
    const envelope = {
      status: 'ok',
      http_status: 200,
      data: { ok: true, motivo: 'data_confere', validado: true },
      query_echo: { intent_key: 'realizar_agendamento' },
    };
    expect(criouEventoNesteTurno([chamada('realizar_agendamento', envelope)])).toBe(true);
  });

  it('envelope status=ok cujo `data` traz success:false continua sendo falha', () => {
    const envelope = { status: 'ok', http_status: 200, data: { success: false }, query_echo: {} };
    expect(criouEventoNesteTurno([chamada('realizar_agendamento', envelope)])).toBe(false);
  });

  it('formato antigo (sem envelope) segue funcionando', () => {
    expect(criouEventoNesteTurno([chamada('create_event', { success: true })])).toBe(true);
    expect(criouEventoNesteTurno([chamada('create_event', { success: false })])).toBe(false);
    expect(criouEventoNesteTurno([chamada('create_event', { error: 'boom' })])).toBe(false);
  });

  it('ferramenta que não cria evento é ignorada', () => {
    expect(criouEventoNesteTurno([chamada('atualizar_lead_crm', { success: true })])).toBe(false);
  });
});

describe('afirmaAgendamento — "por ordem de chegada" não pode mais desarmar o guard', () => {
  it('reconhece a confirmação PADRÃO da LP Saúde', () => {
    expect(
      afirmaAgendamento([
        'Sua consulta com Dr. João Silva ficou para 01/09/2026.\n' +
          '• Valor: R$ 100,00\n' +
          '• Atendimento por ordem de chegada, chegue um pouco antes',
      ]),
    ).toBe(true);
  });

  it('continua ignorando a política dita como fato isolado', () => {
    expect(afirmaAgendamento(['Está confirmado que o atendimento é por ordem de chegada.'])).toBe(false);
    expect(afirmaAgendamento(['A consulta é por ordem de chegada, não tem hora marcada.'])).toBe(false);
  });

  it('continua ignorando proposta em aberto', () => {
    expect(afirmaAgendamento(['Posso confirmar esse horário para você?'])).toBe(false);
    expect(afirmaAgendamento(['Quer que eu agende para amanhã às 09h?'])).toBe(false);
  });

  it('continua ignorando relatório interno para a equipe', () => {
    expect(
      afirmaAgendamento(['✅ Atenção: Agendamento confirmado no whatsapp da LP Saúde ✅\nNome do cliente: Erilaine']),
    ).toBe(false);
  });
});
