import { describe, it, expect } from 'vitest';
import {
  correcaoDePergunta,
  detectarPerguntaRepetida,
  extrairPerguntas,
  mesmaPergunta,
  type FalaDoHistorico,
} from './pergunta-repetida';

const ag = (content: string): FalaDoHistorico => ({ role: 'assistant', content });
const cli = (content: string): FalaDoHistorico => ({ role: 'user', content });

describe('extrairPerguntas', () => {
  it('pega só o trecho depois do último ponto', () => {
    expect(extrairPerguntas('Esse perfil costuma ir bem pra renda e valorização em Manaíra. Pensa em fechar pra quando?'))
      .toEqual(['Pensa em fechar pra quando?']);
  });

  it('várias perguntas e quebra de linha', () => {
    expect(extrairPerguntas('Oi, Ana!\nQual bairro?\nE quantos quartos você precisa??')).toEqual(['Qual bairro?', 'E quantos quartos você precisa??']);
  });

  it('texto sem "?" não tem pergunta', () => {
    expect(extrairPerguntas('Separei duas opções em Manaíra.')).toEqual([]);
  });
});

describe('mesmaPergunta', () => {
  it('igual com acento e pontuação diferentes', () => {
    expect(mesmaPergunta('Em qual região você pensa?', 'em qual regiao voce pensa??')).toBe(true);
  });

  it('a mesma pergunta com outras palavras vazias e verbo flexionado', () => {
    expect(mesmaPergunta('Em qual região você pensa?', 'E em qual região você está pensando?')).toBe(true);
  });

  it('perguntas diferentes da qualificação não são a mesma', () => {
    expect(mesmaPergunta('Pensa em fechar pra quando?', 'Quer agendar uma visita pra quando?')).toBe(false);
    expect(mesmaPergunta('Quantos quartos você precisa?', 'Quantas vagas de garagem você precisa?')).toBe(false);
    expect(mesmaPergunta('Você prefere apartamento ou casa?', 'Prefere apartamento pronto ou na planta?')).toBe(false);
    expect(mesmaPergunta('Em qual região você pensa?', 'Qual o valor que você pensa em investir?')).toBe(false);
  });

  it('pergunta curta de cortesia não conta ("Tudo bem?", "Pode ser?")', () => {
    expect(mesmaPergunta('Tudo bem?', 'Tudo bem?')).toBe(false);
    expect(mesmaPergunta('Pode ser?', 'Pode ser?')).toBe(false);
  });

  it('pergunta curta contida na longa conta', () => {
    expect(mesmaPergunta('Pensa em fechar pra quando?', 'E você pensa em fechar negócio pra quando, mais ou menos?')).toBe(true);
  });
});

describe('detectarPerguntaRepetida', () => {
  it('caso Canda: "Pensa em fechar pra quando?" depois de "Investir"', () => {
    const historico = [ag('Ótimo! Pensa em fechar pra quando?'), cli('Investir')];
    const r = detectarPerguntaRepetida(
      'Esse perfil costuma ir bem pra renda e valorização em Manaíra. Pensa em fechar pra quando?',
      historico,
      'Investir',
    );
    expect(r).toMatchObject({ pergunta: 'Pensa em fechar pra quando?', anterior: 'Pensa em fechar pra quando?' });
    expect(r?.correcao).toContain('você já perguntou "Pensa em fechar pra quando?"');
    expect(r?.correcao).toContain('Não repita essa pergunta');
  });

  it('caso Canda, 3ª vez: "Moro em Recife"', () => {
    const historico = [
      ag('Pensa em fechar pra quando?'),
      cli('Investir'),
      ag('Esse perfil costuma ir bem pra renda e valorização em Manaíra. Pensa em fechar pra quando?'),
      cli('Moro em Recife'),
    ];
    expect(detectarPerguntaRepetida('Então você vai comprar de fora. Pensa em fechar pra quando?', historico, 'Moro em Recife'))
      .not.toBeNull();
  });

  it('caso Canda: "Em qual região você pensa?" repetida', () => {
    const historico = [ag('Legal! Em qual região você pensa?'), cli('Quero 3 quartos')];
    expect(detectarPerguntaRepetida('Anotado, 3 quartos. Em qual região você pensa?', historico, 'Quero 3 quartos')?.pergunta)
      .toBe('Em qual região você pensa?');
  });

  it('pergunta diferente da anterior passa', () => {
    const historico = [ag('Pensa em fechar pra quando?'), cli('Uns 6 meses')];
    expect(detectarPerguntaRepetida('Perfeito. Em qual região você pensa?', historico, 'Uns 6 meses')).toBeNull();
  });

  it('resposta sem pergunta passa', () => {
    expect(detectarPerguntaRepetida('Separei duas opções pra você.', [ag('Em qual região você pensa?')])).toBeNull();
  });

  it('só olha as últimas 4 falas da agente', () => {
    const historico = [
      ag('Em qual região você pensa?'), cli('a'),
      ag('Quantos quartos?'), cli('b'),
      ag('Prefere casa ou apartamento?'), cli('c'),
      ag('Tem vaga de garagem como requisito?'), cli('d'),
      ag('Vai financiar ou pagar à vista?'), cli('e'),
    ];
    expect(detectarPerguntaRepetida('Em qual região você pensa?', historico)).toBeNull();
    expect(detectarPerguntaRepetida('Em qual região você pensa?', historico.slice(0, 8))).not.toBeNull();
  });

  it('fala do cliente não conta como pergunta da agente', () => {
    expect(detectarPerguntaRepetida('Em qual região você pensa?', [cli('Em qual região você pensa?')])).toBeNull();
  });

  it('ficha de imóvel nova: "É esse imóvel que te atende?" depois de outro imóvel não é repetição', () => {
    const historico = [
      ag('Apartamento em Manaíra, 3 quartos.\nhttps://costaemuniz.com.br/site/imovel/AP123\nÉ esse imóvel que te atende?'),
      cli('Queria mais perto da praia'),
    ];
    const nova = 'Esse fica a 1 quadra da praia.\nhttps://costaemuniz.com.br/site/imovel/AP456\nÉ esse imóvel que te atende?';
    expect(detectarPerguntaRepetida(nova, historico, 'Queria mais perto da praia')).toBeNull();
  });

  it('a mesma ficha de novo com a mesma pergunta é repetição', () => {
    const ficha = 'https://costaemuniz.com.br/site/imovel/AP123';
    const historico = [ag(`Olha esse.\n${ficha}\nÉ esse imóvel que te atende?`), cli('Tem garagem?')];
    expect(detectarPerguntaRepetida(`Tem 2 vagas.\n${ficha}\nÉ esse imóvel que te atende?`, historico, 'Tem garagem?')).not.toBeNull();
  });

  it('confirmação de imóvel sem ficha nova é repetição', () => {
    const historico = [ag('Olha esse.\nhttps://costaemuniz.com.br/site/imovel/AP123\nÉ esse imóvel que te atende?'), cli('Hmm')];
    expect(detectarPerguntaRepetida('Ele tem varanda gourmet. É esse imóvel que te atende?', historico, 'Hmm')).not.toBeNull();
  });

  it('cliente pediu para repetir: pode perguntar de novo', () => {
    const historico = [ag('Pensa em fechar pra quando?')];
    expect(detectarPerguntaRepetida('Pensa em fechar pra quando?', historico, 'Não entendi')).toBeNull();
    expect(detectarPerguntaRepetida('Pensa em fechar pra quando?', historico, 'como assim?')).toBeNull();
    expect(detectarPerguntaRepetida('Pensa em fechar pra quando?', historico, 'oi?')).toBeNull();
  });

  it('"oi" no meio de outra fala não libera a repetição', () => {
    const historico = [ag('Pensa em fechar pra quando?')];
    expect(detectarPerguntaRepetida('Pensa em fechar pra quando?', historico, 'oi, moro em Recife')).not.toBeNull();
  });

  it('histórico vazio passa', () => {
    expect(detectarPerguntaRepetida('Em qual região você pensa?', [])).toBeNull();
  });
});

describe('correcaoDePergunta', () => {
  it('cita a pergunta e pede para avançar', () => {
    expect(correcaoDePergunta('Em qual região você pensa?')).toBe(
      '[Instrução interna, não é do cliente: você já perguntou "Em qual região você pensa?" e o cliente respondeu outra coisa. ' +
        'Não repita essa pergunta, nem com outras palavras. Aproveite o que ele disse, avance com outra pergunta ' +
        'diferente ou mostre opções. Reescreva a resposta no mesmo formato de saída.]',
    );
  });
});
