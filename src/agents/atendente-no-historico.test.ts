import { describe, it, expect } from 'vitest';
import { notaDoAtendente, MAX_LINHAS_DA_NOTA, MAX_CHARS_POR_FALA } from './atendente-no-historico';
import type { MensagemDaConversa } from './rajada';

const m = (
  created_at: string,
  direction: 'inbound' | 'outbound',
  content: string,
  sender_name: string | null = null,
  message_type = 'text',
): MensagemDaConversa => ({
  created_at,
  direction,
  message_type,
  content,
  sender_name,
  from_device: direction === 'outbound' && !!sender_name && sender_name !== 'system',
});

// Leandro/Quiroleve, lead dc8ce310 (nome do paciente trocado). Horários em UTC (BRT = UTC-3).
const CASO_REAL: MensagemDaConversa[] = [
  m('2026-10-30T11:39:10Z', 'inbound', 'Pode agendar \nPorém eu pago em dinheiro', 'Paciente'),
  m('2026-10-30T11:39:40Z', 'outbound', 'Pra garantir terça, 03/11 às 11h em Ibiporã eu peço um sinal de R$ 50,00 no Pix, tá?'),
  m('2026-10-31T18:11:00Z', 'outbound', 'Fulano sua sessa está agendada para terça feira dia 3/11 às 11hs tá', 'Leandro'),
  m('2026-10-31T18:12:00Z', 'outbound', '.', 'Quiroleve Ltda'),
  m('2026-10-31T18:12:05Z', 'outbound', 'Atendimento devolvido para IA via dispositivo', null, 'system'),
  m('2026-10-31T18:21:00Z', 'inbound', 'Ta confirmado', 'Paciente'),
  m('2026-10-31T18:22:00Z', 'outbound', 'Oi, boa tarde! Ainda não tá confirmado, tá? Só me confirma seu nome pra eu colocar certinho na agenda.'),
  m('2026-10-31T18:23:00Z', 'outbound', 'Obrigado e até terça', 'Leandro'),
  m('2026-10-31T22:25:00Z', 'outbound', 'Follow-up #1 enviado automaticamente', null, 'system'),
  m('2026-11-03T12:35:00Z', 'outbound', 'Bom dia tudo bem?\n\nPassando para lembra lo de sua avaliação e sessão de quiropraxia hoje às 11hs na unidade de Ibiporã!!', 'Leandro'),
  m('2026-11-03T12:36:00Z', 'inbound', 'Sim, está tudo combinado', 'Paciente'),
  m('2026-11-03T12:36:30Z', 'outbound', 'Obrigado, estarei lhe aguardando', 'Leandro'),
  m('2026-11-03T14:31:00Z', 'outbound', '', 'Leandro', 'image'),
  m('2026-11-03T14:31:05Z', 'outbound', '', 'Leandro', 'image'),
  m('2026-11-03T14:31:10Z', 'outbound', '', 'Leandro', 'image'),
  m('2026-11-10T12:33:53Z', 'outbound', 'Bom dia tudo bem?\nHoje temos um horário às 11hs agendado com muito carinho pra você!\nPreciso que você confirme tua presença por favor!!', 'Leandro'),
  m('2026-11-10T12:35:38Z', 'inbound', 'BOM DIA', 'Paciente'),
  m('2026-11-10T12:35:39Z', 'inbound', 'SIM', 'Paciente'),
  m('2026-11-10T13:34:00Z', 'outbound', 'Atendimento devolvido para a IA automaticamente (60 min sem mensagem do atendente)', 'system', 'system'),
];
const AGORA = Date.parse('2026-11-10T13:34:05Z'); // 10:34 BRT, o turno que respondeu torto

describe('notaDoAtendente', () => {
  it('caso real: o lembrete do dono entra com data e hora de Brasília', () => {
    const nota = notaDoAtendente(CASO_REAL, AGORA)!;
    expect(nota).toMatch(/ter 10\/11 09:33 · Leandro \(atendente\): "Bom dia tudo bem\? Hoje temos um horário às 11hs agendado/);
    expect(nota).toMatch(/sáb 31\/10 15:11 · Leandro \(atendente\): "Fulano sua sessa está agendada para terça feira dia 3\/11 às 11hs tá"/);
    expect(nota).toMatch(/ter 03\/11 09:36 · cliente: "Sim, está tudo combinado"/);
    expect(nota).toMatch(/sáb 31\/10 15:22 · você: "Oi, boa tarde! Ainda não tá confirmado/);
    expect(nota).toMatch(/não inicie agendamento, cobrança nem consulta de agenda/);
  });

  it('as falas do cliente deste turno ficam fora (já chegam como mensagem do turno)', () => {
    const nota = notaDoAtendente(CASO_REAL, AGORA)!;
    expect(nota).not.toMatch(/"SIM"/);
    expect(nota).not.toMatch(/"BOM DIA"/);
  });

  it('mensagem de sistema e o "." de devolver para a IA não entram', () => {
    const nota = notaDoAtendente(CASO_REAL, AGORA)!;
    expect(nota).not.toMatch(/Follow-up #1/);
    expect(nota).not.toMatch(/devolvido/);
    expect(nota).not.toMatch(/Quiroleve Ltda/);
  });

  it('mídias seguidas do atendente viram uma linha só, sem inventar conteúdo', () => {
    const nota = notaDoAtendente(CASO_REAL, AGORA)!;
    expect(nota).toMatch(/Leandro \(atendente\): \[imagem ×3, você não vê o conteúdo\]/);
  });

  it('conversa só de cliente e IA → sem nota', () => {
    const soIa = CASO_REAL.filter((x) => x.direction === 'inbound' || !x.sender_name);
    expect(notaDoAtendente(soIa, AGORA)).toBeNull();
    expect(notaDoAtendente([], AGORA)).toBeNull();
  });

  it('fala do atendente fora da janela de 14 dias → sem nota', () => {
    const velho = [
      m('2026-10-01T12:00:00Z', 'outbound', 'Te espero amanhã', 'Leandro'),
      m('2026-11-10T12:00:00Z', 'outbound', 'Oi! Consigo terça às 11h.'),
      m('2026-11-10T12:01:00Z', 'inbound', 'Pode ser', 'Paciente'),
    ];
    expect(notaDoAtendente(velho, AGORA)).toBeNull();
  });

  it('atendente falou, mas já saiu das últimas linhas → sem nota', () => {
    const msgs = [m('2026-11-09T12:00:00Z', 'outbound', 'Oi, aqui é o Leandro', 'Leandro')];
    for (let i = 0; i < MAX_LINHAS_DA_NOTA; i++) {
      msgs.push(m(`2026-11-10T10:${String(i).padStart(2, '0')}:00Z`, i % 2 ? 'outbound' : 'inbound', `fala ${i}`, i % 2 ? null : 'Paciente'));
    }
    msgs.push(m('2026-11-10T11:00:00Z', 'outbound', 'última da IA'));
    expect(notaDoAtendente(msgs, AGORA)).toBeNull();
  });

  it('fala longa é cortada e a nota tem no máximo MAX_LINHAS_DA_NOTA linhas', () => {
    const msgs: MensagemDaConversa[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(m(`2026-11-10T10:${String(i).padStart(2, '0')}:00Z`, 'outbound', `${'x'.repeat(600)} ${i}`, 'Leandro'));
    }
    const nota = notaDoAtendente(msgs, AGORA)!;
    const linhas = nota.split('\n').filter((l) => l.startsWith('- '));
    expect(linhas).toHaveLength(MAX_LINHAS_DA_NOTA);
    expect(linhas.every((l) => l.length < MAX_CHARS_POR_FALA + 80)).toBe(true);
    expect(nota).toMatch(/…"/);
  });
});
