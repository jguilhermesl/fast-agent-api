import { describe, expect, it } from 'vitest';
import {
  acrescentarAvisos,
  checarDataUnidade,
  checarServico,
  instrucaoDataUnidade,
  lerConfig,
  mapaDaAgenda,
  paresDataUnidade,
} from './trava-unidade';

// Formato real do retorno do google_calendar_horarios_disponiveis do Leandro (17/11/2026), embrulhado como o
// executor devolve (data.data).
const retornoAgenda = {
  status: 'ok',
  http_status: 200,
  data: {
    success: true,
    data: {
      available_slots: [
        { date: '2026-11-18', day: 'quarta', slots: ['13:00', '14:00'], slots_por_unidade: [{ horario: '13:00', unidade: 'Londrina' }, { horario: '14:00', unidade: 'Londrina' }] },
        { date: '2026-11-19', day: 'quinta', slots: ['11:00'], slots_por_unidade: [{ horario: '11:00', unidade: 'Ibiporã' }] },
        { date: '2026-11-21', day: 'sábado', slots: ['09:00', '15:00'], slots_por_unidade: [{ horario: '09:00', unidade: 'Londrina' }, { horario: '15:00', unidade: 'Ibiporã' }] },
      ],
    },
  },
};
const agenda = mapaDaAgenda([retornoAgenda]);

const invertida = {
  gatilho: 'invertid|mesa de invers|suspens|cabeca p(a)?ra baixo|ponta cabeca',
  unidades: ['Ibiporã'],
  aviso: 'sem a mesa|quiropraxia|so em ibipor',
  aviso_texto: 'Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão.',
};

describe('mapaDaAgenda', () => {
  it('lê slots_por_unidade em qualquer profundidade, por data dd/mm, unidade sem acento', () => {
    expect([...agenda.keys()]).toEqual(['18/11', '19/11', '21/11']);
    expect([...agenda.get('19/11')!]).toEqual(['ibipora']);
    expect([...agenda.get('21/11')!].sort()).toEqual(['ibipora', 'londrina']);
  });
  it('aceita o retorno como texto JSON e ignora texto livre', () => {
    expect(mapaDaAgenda([JSON.stringify(retornoAgenda), 'Consulta feita.']).size).toBe(3);
    expect(mapaDaAgenda(['nada aqui']).size).toBe(0);
  });
});

describe('paresDataUnidade', () => {
  it('liga cada data à unidade do seu trecho (separado por "ou")', () => {
    const t = 'Consigo quarta, 18/11 às 13h em Londrina ou quinta, 19/11 às 11h em Ibiporã, qual fica melhor?';
    expect(paresDataUnidade(t, ['londrina', 'ibipora']).map((p) => `${p.data}:${p.unidade}`)).toEqual(['18/11:londrina', '19/11:ibipora']);
  });
  it('sem unidade depois da data, usa a última antes ("Em Londrina consigo quarta, 18/11")', () => {
    const t = 'Em Londrina consigo quarta, 18/11 às 13h ou às 14h. Qual fica melhor pra você?';
    expect(paresDataUnidade(t, ['londrina', 'ibipora']).map((p) => `${p.data}:${p.unidade}`)).toEqual(['18/11:londrina']);
  });
  it('frase sem data não gera par', () => {
    expect(paresDataUnidade('Sou de Londrina, vocês atendem aí?', ['londrina'])).toEqual([]);
  });
});

describe('checarDataUnidade', () => {
  it('acusa quinta oferecida em Londrina quando a agenda só tem quinta em Ibiporã (grupo 19/08)', () => {
    const v = checarDataUnidade(['Consigo quinta, 19/11 às 11h em Londrina, pode ser?'], agenda);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ data: '19/11', unidade: 'londrina', unidadesDaAgenda: ['ibipora'] });
    expect(instrucaoDataUnidade(v)).toContain('19/11 foi oferecido em londrina');
  });
  it('acusa quarta em Ibiporã (gpt-5.4-mini na bancada de 17/11)', () => {
    expect(checarDataUnidade(['Tenho sim, em Ibiporã na quarta, 18/11, tenho 13h e 14h.'], agenda)).toHaveLength(1);
  });
  it('aceita a oferta certa, uma de cada unidade', () => {
    expect(checarDataUnidade(['Consigo quarta, 18/11 às 13h em Londrina ou quinta, 19/11 às 11h em Ibiporã.'], agenda)).toEqual([]);
  });
  it('sábado tem as duas unidades: não acusa nenhuma', () => {
    expect(checarDataUnidade(['Sábado, 21/11 às 9h em Londrina ou às 15h em Ibiporã.'], agenda)).toEqual([]);
  });
  it('data que a agenda do turno não trouxe fica de fora', () => {
    expect(checarDataUnidade(['Consigo 25/11 às 10h em Ibiporã.'], agenda)).toEqual([]);
  });
  it('negação não é oferta (falsos positivos reais de 30 dias do Leandro)', () => {
    expect(checarDataUnidade(['Em Londrina amanhã, quinta 19/11, eu não atendo. Consigo quarta, 18/11 às 13h.'], agenda)).toEqual([]);
    expect(checarDataUnidade(['Em Londrina, quinta 19/11 não abre. Consigo sábado, 21/11 às 9h.'], agenda)).toEqual([]);
    expect(checarDataUnidade(['No sábado, 18/11, não apareceu horário em Ibiporã.'], agenda)).toEqual([]);
  });
  it('sem agenda no turno não acusa nada', () => {
    expect(checarDataUnidade(['Consigo quinta, 19/11 às 11h em Londrina.'], new Map())).toEqual([]);
  });
});

describe('checarServico (invertida só em Ibiporã)', () => {
  const base = { agenda, servicos: [invertida], unidades: ['Londrina', 'Ibiporã'] };
  it('caso Anderson 17/11: falou da mesa "suspensa" e a resposta oferece Londrina sem aviso → aviso', () => {
    const r = checarServico({
      ...base,
      mensagens: ['Em Londrina consigo quarta, 18/11 às 13h ou às 14h. Qual fica melhor pra você?'],
      clientMessage: '[Áudio] Aqui em Londrina é melhor.',
      falasRecentesDoAgente: ['Sim, é a terapia invertida mesmo, você fica inclinado na mesa.'],
    });
    expect(r).toHaveLength(1);
    expect(acrescentarAvisos(['Em Londrina consigo quarta, 18/11 às 13h.'], r)[0]).toContain('sem a mesa de inversão');
  });
  it('resposta que já avisa ("lá é quiropraxia, sem a mesa") passa', () => {
    expect(
      checarServico({
        ...base,
        mensagens: ['Em Londrina a sessão é de quiropraxia, sem a mesa. Tenho quarta, 18/11 às 13h.'],
        clientMessage: 'Aqui em Londrina é melhor',
        falasRecentesDoAgente: ['A terapia invertida eu faço só em Ibiporã.'],
      }),
    ).toEqual([]);
  });
  it('oferta só em Ibiporã com a invertida passa', () => {
    expect(
      checarServico({ ...base, mensagens: ['Tenho quinta, 19/11 às 11h em Ibiporã.'], clientMessage: 'quero a terapia invertida', falasRecentesDoAgente: [] }),
    ).toEqual([]);
  });
  it('sem o assunto na conversa, Londrina passa sem aviso', () => {
    expect(
      checarServico({ ...base, mensagens: ['Consigo quarta, 18/11 às 13h em Londrina.'], clientMessage: 'tenho dor no ombro', falasRecentesDoAgente: [] }),
    ).toEqual([]);
  });
  it('já avisou nas últimas falas: não repete o aviso', () => {
    expect(
      checarServico({
        ...base,
        mensagens: ['Consigo quarta, 18/11 às 14h em Londrina.'],
        clientMessage: 'pode ser em Londrina',
        falasRecentesDoAgente: ['Tenho quarta, 18/11 às 13h em Londrina.\nLá em Londrina a sessão é de quiropraxia, sem a mesa de inversão.'],
      }),
    ).toEqual([]);
  });
  it('caso real 17/11 (conv d61ceafd): "vídeo que pendura de cabeça para baixo" e oferta só em Londrina → aviso', () => {
    expect(
      checarServico({
        ...base,
        mensagens: ['Beleza, vê com ela sim. Pra segunda, 23/11 em Londrina, consigo às 14h ou 15h.'],
        clientMessage: 'Tem um vídeo aqui que pendura o cara de cabeça para baixo, quanto que é?',
        falasRecentesDoAgente: [],
      }),
    ).toHaveLength(1);
  });
  it('acha Londrina mesmo sem agenda no turno (confirmação "tá marcado")', () => {
    expect(
      checarServico({
        agenda: new Map(),
        servicos: [invertida],
        unidades: ['Londrina', 'Ibiporã'],
        mensagens: ['Fechado, tá marcado pra quarta, 18/11 às 13h em Londrina!'],
        clientMessage: 'Ok',
        falasRecentesDoAgente: ['Tem sim, é lá mesmo que eu faço a terapia invertida.'],
      }),
    ).toHaveLength(1);
  });
});

describe('lerConfig', () => {
  it('sem chave ou modo inválido = desligado', () => {
    expect(lerConfig(undefined)).toBeNull();
    expect(lerConfig({ modo: 'x' })).toBeNull();
  });
  it('descarta serviço com regex inválida e mantém o resto', () => {
    const c = lerConfig({ modo: 'enforce', unidades: ['Londrina', 'Ibiporã'], servicos: [invertida, { ...invertida, gatilho: '(' }] });
    expect(c).toMatchObject({ modo: 'enforce', unidades: ['Londrina', 'Ibiporã'] });
    expect(c!.servicos).toHaveLength(1);
  });
});
