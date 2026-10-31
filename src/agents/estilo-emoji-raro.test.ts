import { describe, it, expect } from 'vitest';
import { aplicarEstilo, lerEstilo } from './estilo-deterministico';

describe('emoji: "raro" (31/10/2026)', () => {
  it('tira o emoji de assinatura e mantém os informativos do bloco de preço', () => {
    const bloco = [
      'Ultrassom de tireoide',
      '💳 Cartão: R$ 180,00',
      '💰 Pix: R$ 170,00',
      'Qual dia fica melhor pra você? 😊',
    ].join('\n');
    const r = aplicarEstilo([bloco], { emoji: 'raro' });
    expect(r.mensagens).toEqual([
      ['Ultrassom de tireoide', '💳 Cartão: R$ 180,00', '💰 Pix: R$ 170,00', 'Qual dia fica melhor pra você?'].join('\n'),
    ]);
    expect(r.mudancas.emojisRemovidos).toBe(1);
  });

  it('mensagem só de emoji some; 📄 e 📍 ficam', () => {
    const r = aplicarEstilo(['Perfeito, até amanhã! 😊🙏', '😊', '📄 Leve o pedido médico. 📍 Rua X, 10'], { emoji: 'raro' });
    expect(r.mensagens).toEqual(['Perfeito, até amanhã!', '📄 Leve o pedido médico. 📍 Rua X, 10']);
  });

  it('emoji informativo com variação FE0F também fica (o FE0F solto sai na limpeza, o 📍 não)', () => {
    const r = aplicarEstilo(['📍️ Rua X, 10 😊'], { emoji: 'raro' });
    expect(r.mensagens).toEqual(['📍 Rua X, 10']);
  });

  it('lerEstilo aceita "raro" e ignora outro texto', () => {
    expect(lerEstilo({ emoji: 'raro' })).toEqual({ emoji: 'raro' });
    expect(lerEstilo({ emoji: 'pouco' })).toEqual({});
  });

  it('emoji: false continua tirando tudo, inclusive os informativos', () => {
    const r = aplicarEstilo(['💳 Cartão: R$ 180,00 😊'], { emoji: false });
    expect(r.mensagens).toEqual(['Cartão: R$ 180,00']);
  });
});
