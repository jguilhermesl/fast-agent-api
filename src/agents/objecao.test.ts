import { describe, it, expect } from 'vitest';
import { classificarMensagem, prefixoDeClassificacao, PREFIXO_OBJECAO, PREFIXO_RECUSA } from './objecao';

// Frases reais de cliente da Duda (estudo 02, 30/09/2026) sempre que existem.
describe('classificarMensagem: recusa explícita', () => {
  const recusas = [
    'NÃO  TENHO INTERESSE!!!',                              // 9283fb6f, dois espaços
    'NÃO TENHO INTERESSE!!!\nPELA DISTÂNCIA DE RECIFE',     // recusa com motivo continua recusa
    'Não obrigado',                                          // b3a41996
    'não, obrigada',
    'Não, obrigada. Não tenho interesse.',
    'nao tenho mais interesse',
    'Não quero',
    'não quero mais!',
    'Não quero não',
    'não preciso mais',
    'Deixa pra lá',
    'desisti',
    'não é pra mim',
    'Sem interesse, obrigado',
    'não tenho interesse, é muito longe',                   // recusa vence objeção
  ];
  for (const m of recusas) {
    it(`"${m}" é recusa`, () => expect(classificarMensagem(m)).toBe('recusa'));
  }
});

describe('classificarMensagem: objeção real continua objeção', () => {
  const objecoes = [
    'tá caro',
    'Ta caro demais',
    'achei caro',
    'Muito caro',
    'é longe',
    'fica muito longe pra mim',
  ];
  for (const m of objecoes) {
    it(`"${m}" é objeção`, () => expect(classificarMensagem(m)).toBe('objecao'));
  }
});

describe('classificarMensagem: nem recusa nem objeção', () => {
  const nenhum = [
    // Pedido sobre agendamento: é transferência, não recusa nem objeção. Os dois
    // primeiros eram marcados como OBJEÇÃO e recebiam roteiro de venda.
    'Não cancela, não quero pra outra semana',
    'Eu não posso ir esse mês não',                         // d731c120, quer remarcar
    'não vou poder ir amanhã, dá pra remarcar?',
    'não quero mais essa data, quero remarcar',
    'Não quero cancelar',
    // Pergunta não é recusa.
    'não preciso de requisição?',
    'Não quero de manhã, tem à tarde?',
    // Preferência e resposta a pergunta de triagem.
    'Não quero esse horário',
    'Não, é para concurso',
    'Não, é pra minha filha',
    'não preciso de jejum então',
    // Adiamento fica com a persona, sem prefixo.
    'vou pensar',
    'Vou ver direitinho e te aviso',
    'deixa pra outro momento',
    // Mensagem comum.
    'Muito obrigada!!!',
    'quanto custa o hemograma?',
    'Obrigada, mas tem outro horário?',
  ];
  for (const m of nenhum) {
    it(`"${m}" não tem pré-classificação`, () => expect(classificarMensagem(m)).toBeNull());
  }

  it('mensagem longa nunca é classificada', () => {
    expect(classificarMensagem('não tenho interesse ' + 'a'.repeat(200))).toBeNull();
  });
  it('mensagem vazia não é classificada', () => {
    expect(classificarMensagem('   ')).toBeNull();
  });
});

describe('prefixoDeClassificacao', () => {
  it('recusa leva o prefixo de recusa, que manda não insistir e não fala em objeção como regra', () => {
    const p = prefixoDeClassificacao('NÃO TENHO INTERESSE!!!');
    expect(p).toBe(PREFIXO_RECUSA);
    expect(p).toMatch(/RECUSA EXPL[IÍ]CITA/);
    expect(p).toMatch(/não insista/);
    expect(p).not.toMatch(/aplique as regras de tratamento de objeção/);
  });
  it('objeção real mantém o prefixo antigo, byte a byte', () => {
    expect(prefixoDeClassificacao('tá caro')).toBe(PREFIXO_OBJECAO);
    expect(PREFIXO_OBJECAO).toBe(
      '[PRÉ-CLASSIFICAÇÃO AUTOMÁTICA: OBJEÇÃO (categoria A) — aplique as regras de tratamento de objeção da PERSONA. NÃO encerre a conversa. NÃO acione "Encerrar conversa".]',
    );
  });
  it('sem classificação, sem prefixo', () => {
    expect(prefixoDeClassificacao('Eu não posso ir esse mês não')).toBe('');
  });
});
