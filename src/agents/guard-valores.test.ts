import { describe, it, expect } from 'vitest';
import { checarValoresSemFonte, datasDitasPeloCliente } from './guard';

const vazio = { clientMessage: '', history: '', systemPrompt: '' };

// Retorno real da busca de 13/10/2026 14:58 (lead 18ac4f90), resumido.
const buscaPreventivo = JSON.stringify([
  {
    nome: 'Prevenção, Preventivo, Prevenção Completa, Papanicolau, Citologia + Colposcopia',
    preco: 'R$ 150,00 (Sem direito a retorno)',
    disponibilidades: [
      { 'data/horario': 'quinta, 15/10/2026 - 14:30 - Ordem de chegada', profissional: 'Raiany Rodrigues' },
      { 'data/horario': 'segunda, 19/10/2026 - 08:30 - Ordem de chegada', profissional: 'Amanda Alencar' },
      { 'data/horario': 'terça, 27/10/2026 - 09:00 - Ordem de chegada', profissional: 'Aline Cordeiro' },
    ],
  },
  { nome: 'Colposcopia', preco: 'R$ 90,00' },
  { nome: 'Citologia', preco: 'R$ 80,00' },
]);

describe('checarValoresSemFonte', () => {
  it('pega o caso real do preventivo: R$ 100 e as datas 16/10 e 23/10 não vieram da busca', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: buscaPreventivo,
      mensagens: ['Prevenção Completa\n• Valor: R$ 100,00\n\nDatas disponíveis:\nAline Cordeiro\n• Sexta-feira, 16/10 às 08h\n• Sexta-feira, 23/10 às 08h'],
    });
    expect(r.map((v) => v.texto)).toEqual(['R$ 100,00', '16/10', '23/10']);
  });

  it('resposta fiel à busca passa', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: buscaPreventivo,
      mensagens: ['Prevenção completa\n• Valor: R$ 150,00\n\nRaiany Rodrigues\n• Quinta-feira, 15/10 às 14h30\nAline Cordeiro\n• Terça-feira, 27/10 às 9h'],
    });
    expect(r).toEqual([]);
  });

  it('total que é soma de valores com fonte passa (caso real de 03/10: R$ 68,50)', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: '[{"preco":"R$ 15,00"},{"preco":"R$ 15,00 "},{"preco":"R$ 8,50"},{"preco":"R$ 30,00"}]',
      mensagens: ['• Hemograma completo, R$ 15,00\n• Creatinina, R$ 15,00\n• Glicemia de jejum, R$ 8,50\n• Coagulograma, R$ 30,00\n\nTotal: R$ 68,50'],
    });
    expect(r).toEqual([]);
  });

  it('soma de soma passa (caso real de 09/10: adicionais R$ 70 + pacote R$ 310 = R$ 380)', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: '[{"preco":"R$310 em até 4x"},{"preco":"R$ 20,00"},{"preco":"R$ 10,00"},{"preco":"R$ 20,00"},{"preco":"R$ 20,00"}]',
      mensagens: ['Pacote R$ 310,00\n• R$ 20,00\n• R$ 10,00\n• R$ 20,00\n• R$ 20,00\nTotal dos adicionais: R$ 70,00\nTotal com o pacote: R$ 380,00'],
    });
    expect(r).toEqual([]);
  });

  it('parcela de valor com fonte passa (2x de R$ 60 de R$ 120)', () => {
    const r = checarValoresSemFonte({ ...vazio, toolResults: '{"preco":"R$ 120,00"}', mensagens: ['R$ 120,00 à vista ou 2x de R$ 60,00'] });
    expect(r).toEqual([]);
  });

  it('total de valores ditos em turno anterior com ferramenta passa (caso real de 14/10: R$ 470)', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: '',
      history: 'Agente: Consulta R$ 150,00, ultrassom R$ 140,00 e mamária R$ 180,00.',
      mensagens: ['Sim, pode pagar tudo no cartão. Pelos valores que te passei, o total fica R$ 470,00.'],
    });
    expect(r).toEqual([]);
  });

  it('horário não é cobrado (caso real: coleta até 15h, chegar 14h50)', () => {
    const r = checarValoresSemFonte({ ...vazio, toolResults: '', mensagens: ['A coleta vai até 15h. Se chegar por volta de 14h50, dá tempo.'] });
    expect(r).toEqual([]);
  });

  it('preço chutado depois de texto pronto é pego (caso real de 07/10: endoscopia R$ 250 / R$ 280)', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: '{"message": "Workflow was started"}',
      systemPrompt: 'Endoscopia: taxa LP R$ 160, total R$ 430 dinheiro / R$ 480 Pix e cartão.',
      mensagens: ['A endoscopia está por R$ 250,00 à vista no PIX ou R$ 280,00 no cartão em até 2x.'],
    });
    expect(r.map((v) => v.texto)).toEqual(['R$ 250,00', 'R$ 280,00']);
  });

  it('valor que está no prompt passa', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      toolResults: '',
      systemPrompt: 'Oftalmologia: R$ 24 na LP Saúde mais R$ 136 na parceira, total R$ 160.',
      mensagens: ['São R$ 24,00 aqui e R$ 136,00 na parceira, total de R$ 160,00.'],
    });
    expect(r).toEqual([]);
  });
});

// 30/10/2026 ~13h BRT (16h UTC), sexta-feira: suíte do Leandro.
const sexta3010 = new Date('2026-10-30T16:00:00Z');

describe('datasDitasPeloCliente', () => {
  it('hoje, amanhã e depois de amanhã no fuso de Brasília', () => {
    expect(datasDitasPeloCliente('dá pra hoje? ou amanhã? ou depois de amanhã', sexta3010).sort()).toEqual(['01/11', '30/10', '31/10']);
  });

  it('dia da semana vale para as duas próximas ocorrências', () => {
    expect(datasDitasPeloCliente('tenho sessão marcada pra sexta', sexta3010)).toEqual(['30/10', '06/11']);
    expect(datasDitasPeloCliente('pode ser terça?', sexta3010)).toEqual(['03/11', '10/11']);
    expect(datasDitasPeloCliente('sábado de manhã', sexta3010)).toEqual(['31/10', '07/11']);
  });

  it('meia-noite UTC ainda é o dia anterior em Brasília', () => {
    expect(datasDitasPeloCliente('amanhã', new Date('2026-10-31T01:30:00Z'))).toEqual(['31/10']);
  });

  it('sem palavra de data, nada', () => {
    expect(datasDitasPeloCliente('quanto custa a sessão?', sexta3010)).toEqual([]);
  });
});

describe('checarValoresSemFonte com data dita em palavra', () => {
  it('caso real da suíte: "antecipar pra amanhã" → "sábado, 31/10" tem fonte', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      agora: sexta3010,
      toolResults: '',
      clientMessage: 'tenho sessão marcada pra sexta, consigo antecipar pra amanhã no horário do almoço?',
      mensagens: ['Consigo sim. Me fala o horário que ficou marcado na sexta, 06/11 pra eu ajustar e te passo as opções de sábado, 31/10.'],
    });
    expect(r).toEqual([]);
  });

  it('data que o cliente não pediu continua sem fonte (caso real 30/10 01:24: "terça, 03/11" sem consultar a agenda)', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      agora: new Date('2026-10-30T04:24:00Z'),
      toolResults: '',
      clientMessage: 'Olá! Gostaria de agendar uma sessão de quiropraxia em Ibiporã.',
      mensagens: ['Tenho terça, 03/11 às 10h ou às 11h em Ibiporã, qual fica melhor pra você?'],
    });
    expect(r.map((v) => v.texto)).toEqual(['03/11']);
  });

  it('o próprio agente escrever "terça" no histórico não vira fonte só pela palavra do cliente', () => {
    const r = checarValoresSemFonte({
      ...vazio,
      agora: sexta3010,
      toolResults: '',
      clientMessage: 'pode ser',
      mensagens: ['Fechado, quinta, 05/11 às 10h.'],
    });
    expect(r.map((v) => v.texto)).toEqual(['05/11']);
  });
});
