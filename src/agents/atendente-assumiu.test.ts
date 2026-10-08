import { describe, it, expect } from 'vitest';
import { atendenteAssumiu, ehFalaDaAtendente, JANELA_ATENDENTE_MS } from './atendente-assumiu';
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
