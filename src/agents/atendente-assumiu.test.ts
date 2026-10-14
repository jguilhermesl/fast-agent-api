import { describe, it, expect } from 'vitest';
import { atendenteAssumiu, ehFalaDaAtendente, equipeFalouDepoisDoCliente, turnoComecaComAtendente, JANELA_ATENDENTE_MS, JANELA_TURNO_MS } from './atendente-assumiu';
import type { EstadoDoLead, MensagemDaConversa } from './rajada';

const ms = (iso: string) => new Date(iso).getTime();
const lead = (handled_by: string | null, status = 'open'): EstadoDoLead => ({ handled_by, status, ai_disabled: false });
const inb = (created_at: string, content: string): MensagemDaConversa => ({
  created_at, direction: 'inbound', message_type: 'text', content, sender_name: 'Cliente', from_device: false,
});
const ia = (created_at: string, content: string, sender_name: string | null = null): MensagemDaConversa => ({
  created_at, direction: 'outbound', message_type: 'text', content, sender_name, from_device: false,
});
const sistema = (created_at: string, content: string): MensagemDaConversa => ({
  created_at, direction: 'outbound', message_type: 'system', content, sender_name: null, from_device: false,
});
const equipe = (created_at: string, content: string, from_device = true): MensagemDaConversa => ({
  created_at, direction: 'outbound', message_type: 'text', content, sender_name: 'Caio Vinicius', from_device,
});

describe('ehFalaDaAtendente', () => {
  it('celular e painel contam; IA, sistema e cliente não', () => {
    expect(ehFalaDaAtendente(equipe('2026-10-08T16:47:20Z', 'Oi'))).toBe(true);
    expect(ehFalaDaAtendente(equipe('2026-10-08T16:47:20Z', 'Oi', false))).toBe(true);
    expect(ehFalaDaAtendente(ia('2026-10-08T16:47:20Z', 'Oi'))).toBe(false);
    expect(ehFalaDaAtendente(ia('2026-10-08T16:47:20Z', '', 'AI'))).toBe(false);
    expect(ehFalaDaAtendente(sistema('2026-10-08T16:47:20Z', 'Motivo da transferência: x'))).toBe(false);
    expect(ehFalaDaAtendente(inb('2026-10-08T16:47:20Z', 'Oi'))).toBe(false);
  });
});

describe('atendenteAssumiu', () => {
  // Conversa final 0772, 08/10/2026 (UTC): atendente 16:47:20,65, IA saiu 16:47:24,84.
  const MSGS_0772 = [
    inb('2026-10-08T16:47:04.396Z', 'É com vocês que eu falo sobre o plano de descontos?'),
    equipe('2026-10-08T16:47:20.650Z', 'Seria para solicitação de boleto ou adicionar dependentes?'),
  ];

  it('caso 0772: atendente escreveu 4 s antes, lead em human: segura', () => {
    expect(atendenteAssumiu(lead('human'), MSGS_0772, ms('2026-10-08T16:47:24.800Z'))).toBe(true);
  });

  it('transferência da própria IA: lead em human sem fala da atendente: envia', () => {
    const msgs = [
      inb('2026-10-08T17:06:28.000Z', 'Ok aguardo'),
      sistema('2026-10-08T17:06:32.322Z', 'Motivo da transferência: Cliente enviou imagem'),
    ];
    expect(atendenteAssumiu(lead('human', 'pending'), msgs, ms('2026-10-08T17:06:32.500Z'))).toBe(false);
  });

  it('atendente devolveu para a IA ("/."): lead em ai: envia', () => {
    expect(atendenteAssumiu(lead('ai'), MSGS_0772, ms('2026-10-08T16:47:24.800Z'))).toBe(false);
  });

  it('fala da atendente fora da janela não segura', () => {
    const agora = ms('2026-10-08T16:47:20.650Z') + JANELA_ATENDENTE_MS + 1;
    expect(atendenteAssumiu(lead('human'), MSGS_0772, agora)).toBe(false);
  });

  it('lead ilegível (null) não segura: falha aberta', () => {
    expect(atendenteAssumiu(null, MSGS_0772, ms('2026-10-08T16:47:24.800Z'))).toBe(false);
  });

  it('created_at inválido é ignorado', () => {
    const msgs = [equipe('ontem', 'Oi')];
    expect(atendenteAssumiu(lead('human'), msgs, ms('2026-10-08T16:47:24.800Z'))).toBe(false);
  });
});

describe('turnoComecaComAtendente', () => {
  // Conversa final 0838, 08/10/2026: o turno do "Ok aguardo" entrou às 14:06:30 com o lead em ai, esperou 15 s
  // e começou com o lead já transferido (14:06:32). Rodou e chamou encerrar_conversa às 14:06:49.
  it('caso LP 08/10 14:06: lead transferido durante a espera do buffer: não roda', () => {
    expect(turnoComecaComAtendente(lead('human', 'pending'))).toBe(true);
  });

  it('lead com a IA: roda', () => {
    expect(turnoComecaComAtendente(lead('ai'))).toBe(false);
  });

  it('pending com handled_by ai (devolução em curso): roda, como antes', () => {
    expect(turnoComecaComAtendente(lead('ai', 'pending'))).toBe(false);
  });

  it('lead ilegível: roda (falha aberta)', () => {
    expect(turnoComecaComAtendente(null)).toBe(false);
  });
});

describe('equipeFalouDepoisDoCliente', () => {
  // 14/10/2026, Duda, 558182716801: cliente 17:09:21/17:09:30, atendente 17:09:51, IA 17:09:56.
  const VERA = [
    ia('2026-10-14T03:34:37Z', 'De nada, Vera'),
    inb('2026-10-14T20:09:21Z', 'Não posso ir amanhã'),
    inb('2026-10-14T20:09:30Z', 'Obrigada!!!'),
    equipe('2026-10-14T20:09:51Z', 'Próxima semana terei: ...'),
  ];

  it('segura com o lead ainda em ai quando a equipe respondeu depois da última fala do cliente', () => {
    expect(equipeFalouDepoisDoCliente(VERA, ms('2026-10-14T20:09:56Z'))).toBe(true);
  });

  it('não segura quando o cliente falou de novo depois da equipe', () => {
    const msgs = [...VERA, inb('2026-10-14T20:12:00Z', 'Pode ser segunda')];
    expect(equipeFalouDepoisDoCliente(msgs, ms('2026-10-14T20:12:20Z'))).toBe(false);
  });

  it('fala da própria IA, nota de sistema e mensagem gravada como AI não contam', () => {
    const msgs = [
      inb('2026-10-14T20:09:30Z', 'Obrigada!!!'),
      sistema('2026-10-14T20:09:55Z', 'Motivo da transferência: x'),
      ia('2026-10-14T20:09:56Z', 'Tudo bem, Vera.'),
      ia('2026-10-14T20:09:57Z', 'Oi', 'AI'),
    ];
    expect(equipeFalouDepoisDoCliente(msgs, ms('2026-10-14T20:10:00Z'))).toBe(false);
  });

  it('mensagem do painel (sem from_device) também conta', () => {
    const msgs = [inb('2026-10-14T20:09:30Z', 'Oi'), equipe('2026-10-14T20:09:40Z', 'Olá', false)];
    expect(equipeFalouDepoisDoCliente(msgs, ms('2026-10-14T20:09:45Z'))).toBe(true);
  });

  it('follow-up: equipe falou depois da última fala do cliente, horas antes, ainda segura', () => {
    const msgs = [inb('2026-10-14T12:00:00Z', 'Vou ver'), equipe('2026-10-14T12:05:00Z', 'Fico no aguardo')];
    expect(equipeFalouDepoisDoCliente(msgs, ms('2026-10-14T18:00:00Z'))).toBe(true);
  });

  it('fala da equipe mais velha que a janela não segura', () => {
    const agora = ms('2026-10-14T20:00:00Z');
    const msgs = [equipe(new Date(agora - JANELA_TURNO_MS - 1000).toISOString(), 'Oi')];
    expect(equipeFalouDepoisDoCliente(msgs, agora)).toBe(false);
  });

  it('conversa sem mensagem não segura', () => {
    expect(equipeFalouDepoisDoCliente([], ms('2026-10-14T20:00:00Z'))).toBe(false);
  });
});
