import { describe, it, expect } from 'vitest';
import { decidirLoopRobo, decidirLoopLento, decidirLoopRoboTurno, normalizarTexto, type MensagemRecebida } from './loop-robo';

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

describe('loop lento (24 h)', () => {
  const AGORA = Date.parse('2026-11-17T12:00:00Z');
  const em = (minAtras: number, content: string): MensagemRecebida => ({
    message_type: 'text',
    content,
    created_at: new Date(AGORA - minAtras * 60_000).toISOString(),
  });
  const CLARO = 'Em caso de dúvidas ou para mais informações, acesse sua conta: https://minhaclaro.claro.com.br/x';

  it('caso Diana/Claro: 1 texto a cada 11 min por 2 dias pausa (a regra da hora sozinha não pega)', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => em(i * 11, CLARO));
    const naHora = msgs.filter((m) => Date.parse(m.created_at!) >= AGORA - 3_600_000);
    expect(decidirLoopRobo(naHora).loop).toBe(false);
    expect(decidirLoopRoboTurno(msgs, AGORA)).toMatchObject({ loop: true, regra: 'lento', distintos: 1 });
  });

  it('23 textos iguais em 24 h ainda não; 24 sim', () => {
    expect(decidirLoopRoboTurno(Array.from({ length: 23 }, (_, i) => em(i * 60, CLARO)), AGORA).loop).toBe(false);
    expect(decidirLoopRoboTurno(Array.from({ length: 24 }, (_, i) => em(i * 55, CLARO)), AGORA).loop).toBe(true);
  });

  it('duas frases alternadas lentas pausam; três não', () => {
    expect(decidirLoopRoboTurno(Array.from({ length: 30 }, (_, i) => em(i * 45, i % 2 ? 'Claro Clube A' : 'Claro Clube B')), AGORA).loop).toBe(true);
    expect(decidirLoopRoboTurno(Array.from({ length: 30 }, (_, i) => em(i * 45, `aviso ${i % 3}`)), AGORA).loop).toBe(false);
  });

  it('paciente real com ok/sim/bom dia espalhados em 24 h não pausa', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => em(i * 20, i % 4 === 0 ? 'ok' : i % 4 === 1 ? 'sim' : i % 4 === 2 ? 'bom dia' : `pergunta ${i}`));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('só "ok", "sim" e "bom dia" em quantidade baixa (10 em 24 h) não pausa', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(i * 120, ['ok', 'sim', 'bom dia'][i % 3]));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('confirmação repetida de paciente ("confirmo" 5 vezes no dia) não pausa', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => em(i * 240, 'confirmo'));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('regra da hora continua igual com mensagens datadas: 10 iguais na hora pausam', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(i * 5, CLARO));
    expect(decidirLoopRoboTurno(msgs, AGORA)).toEqual({ loop: true, textos: 10, distintos: 1, regra: 'repeticao' });
  });

  it('10 iguais espalhadas em 24 h (fora da hora) não pausam', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => em(90 + i * 100, CLARO));
    expect(decidirLoopRoboTurno(msgs, AGORA).loop).toBe(false);
  });

  it('áudio e texto de 1 caractere não contam no loop lento', () => {
    const msgs: MensagemRecebida[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ message_type: 'audio', content: '', created_at: new Date(AGORA - i * 600_000).toISOString() })),
      ...Array.from({ length: 40 }, (_, i) => em(i * 30, '?')),
    ];
    expect(decidirLoopLento(msgs).loop).toBe(false);
  });
});
