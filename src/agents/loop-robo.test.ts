import { describe, it, expect } from 'vitest';
import { decidirLoopRobo, normalizarTexto, type MensagemRecebida } from './loop-robo';

const texto = (content: string): MensagemRecebida => ({ message_type: 'text', content });
const varios = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => texto(f(i)));
const AUTOMATICA = "Hello, I'm sorry we cannot provide you with services for the time being. Please stay tuned.";

describe('decidirLoopRobo', () => {
  it('caso Carol 08/10: a mesma resposta automática 10 vezes na hora é loop', () => {
    expect(decidirLoopRobo(varios(10, () => AUTOMATICA))).toEqual({ loop: true, textos: 10, distintos: 1, regra: 'repeticao' });
  });

  it('9 repetições ainda não é loop', () => {
    expect(decidirLoopRobo(varios(9, () => AUTOMATICA)).loop).toBe(false);
  });

  it('espaço e maiúscula diferentes contam como o mesmo texto', () => {
    const msgs = varios(10, (i) => (i % 2 ? AUTOMATICA.toUpperCase() : `  ${AUTOMATICA.replace(/ /g, '  ')} `));
    expect(decidirLoopRobo(msgs)).toMatchObject({ loop: true, distintos: 1 });
  });

  it('duas frases alternadas 10 vezes é loop', () => {
    expect(decidirLoopRobo(varios(10, (i) => (i % 2 ? 'Mensagem automática A' : 'Mensagem automática B')))).toMatchObject({ loop: true, distintos: 2 });
  });

  it('três frases em 10 mensagens não é loop pela 1ª regra', () => {
    expect(decidirLoopRobo(varios(10, (i) => `frase ${i % 3}`)).loop).toBe(false);
  });

  it('caso Carol 09/10: 63 mensagens com 4 frases é loop (poucas frases)', () => {
    expect(decidirLoopRobo(varios(63, (i) => `aviso ${i % 4}`))).toEqual({ loop: true, textos: 63, distintos: 4, regra: 'poucas_frases' });
  });

  it('20 mensagens com 3 frases ainda não é loop; 24 é', () => {
    expect(decidirLoopRobo(varios(20, (i) => `aviso ${i % 3}`)).loop).toBe(false);
    expect(decidirLoopRobo(varios(24, (i) => `aviso ${i % 3}`)).loop).toBe(true);
  });

  it('a hora humana mais cheia dos 30 dias (46 mensagens, 44 diferentes) passa', () => {
    expect(decidirLoopRobo(varios(46, (i) => (i < 3 ? 'ok' : `pergunta número ${i}`))).loop).toBe(false);
  });

  it('41 mensagens com 25 diferentes passa', () => {
    expect(decidirLoopRobo(varios(41, (i) => `msg ${i % 25}`)).loop).toBe(false);
  });

  it('áudio, foto e figurinha não contam (caso Duda: 38 áudios seguidos)', () => {
    const midia: MensagemRecebida[] = [
      ...Array.from({ length: 38 }, () => ({ message_type: 'audio', content: '' })),
      ...Array.from({ length: 16 }, () => ({ message_type: 'image', content: null })),
      ...Array.from({ length: 18 }, () => ({ message_type: 'sticker', content: '' })),
    ];
    expect(decidirLoopRobo(midia)).toEqual({ loop: false, textos: 0, distintos: 0 });
  });

  it('texto de 1 caractere não conta ("?" repetido por gente impaciente)', () => {
    expect(decidirLoopRobo(varios(15, () => '?')).loop).toBe(false);
  });

  it('"oi" repetido 10 vezes conta (2 caracteres)', () => {
    expect(decidirLoopRobo(varios(10, () => 'oi')).loop).toBe(true);
  });

  it('sem mensagens não é loop', () => {
    expect(decidirLoopRobo([])).toEqual({ loop: false, textos: 0, distintos: 0 });
  });
});

describe('normalizarTexto', () => {
  it('junta espaços, tira as pontas e passa para minúscula', () => {
    expect(normalizarTexto('  Olá   TUDO\n bem ')).toBe('olá tudo bem');
  });
});
