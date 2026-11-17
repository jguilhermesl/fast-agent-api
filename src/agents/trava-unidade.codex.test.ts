import { describe, expect, it } from 'vitest';
import {
  acrescentarAvisos,
  checarDataUnidade,
  checarServico,
  lerConfig,
  mapaDaAgenda,
  normalizar,
  paresDataUnidade,
  type MapaAgenda,
} from './trava-unidade';

// Revisão independente: testes vermelhos expressam comportamento seguro esperado.
// Nenhuma rede, chave, banco, Redis ou agenda real é usado.
const agenda: MapaAgenda = new Map([
  ['18/11', new Set(['londrina'])],
  ['19/11', new Set(['ibipora'])],
  ['21/11', new Set(['londrina', 'ibipora'])],
]);
const invertida = {
  gatilho: 'invertid|mesa de invers|suspens|cabeca p(a)?ra baixo|ponta cabeca',
  unidades: ['Ibiporã'],
  aviso: 'sem a mesa|quiropraxia|so em ibipor',
  aviso_texto: 'Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão.',
};
const servico = (mensagem: string, anteriores: string[] = [], cliente = 'Quero terapia invertida') =>
  checarServico({ mensagens: [mensagem], clientMessage: cliente, falasRecentesDoAgente: anteriores,
    agenda, servicos: [invertida], unidades: ['Londrina', 'Ibiporã'] });

describe('Codex: formatos explícitos e repetição de regex', () => {
  it.each([
    'Consigo 19/11/2026 às 13h30 em Londrina.',
    'Quinta (19/11), às 13:00, em Londrina/PR.',
    'Amanhã, quinta 19/11, às 13h30 em LONDRINA.',
    '📍 Quinta, 19/11 às 13:00, em Londrina 😊',
  ])('detecta data/unidade incompatível: %s', (texto) => {
    expect(checarDataUnidade([texto], agenda)).toHaveLength(1);
  });
  it.each([
    'Quinta (19/11), às 13h30, em Ibipora.',
    'QUINTA 19/11 ÀS 13:00 EM IBIPORÃ.',
    '📍 Quinta, 19/11 em Ibiporã 😊',
    '18/11 em Londrina, 19/11 em Ibiporã.',
  ])('preserva oferta válida: %s', (texto) => {
    expect(checarDataUnidade([texto], agenda)).toEqual([]);
  });
  it('não vaza lastIndex entre frases, mensagens ou chamadas', () => {
    for (let i = 0; i < 3; i++) {
      expect(checarDataUnidade(['19/11 em Londrina.', '18/11 em Ibiporã.'], agenda)).toHaveLength(2);
      expect(servico('18/11 em Londrina.')).toHaveLength(1);
    }
  });
  it('regex inválida em gatilho/aviso é descartada na leitura', () => {
    const c = lerConfig({ modo: 'enforce', servicos: [
      { ...invertida, gatilho: '(' }, { ...invertida, aviso: '[' }, invertida,
    ] });
    expect(c?.servicos).toEqual([invertida]);
  });
  it('cidade com metacaractere é escapada', () => {
    expect(paresDataUnidade('19/11 em A+B', ['a+b'])).toHaveLength(1);
    expect(paresDataUnidade('19/11 em AAAB', ['a+b'])).toEqual([]);
  });
});

describe('Codex: falsos negativos de data/unidade', () => {
  // Ajuste do autor (17/11): a lista de unidades do agente é o terceiro argumento; em produção o orquestrador
  // sempre passa `trava.unidades`. Sem lista, só a agenda diz quais cidades existem.
  it('detecta cidade errada mesmo quando só a cidade certa apareceu na consulta', () => {
    expect(checarDataUnidade(['19/11 em Londrina às 13h.'], new Map([
      ['19/11', new Set(['ibipora'])],
    ]), ['Londrina', 'Ibiporã'])).toHaveLength(1);
  });
  it('não considera dia sem vagas como oferta válida', () => {
    expect(checarDataUnidade(['19/11 em Londrina às 13h.'], new Map([
      ['18/11', new Set(['londrina'])], ['19/11', new Set<string>()],
    ]))).toHaveLength(1);
  });
  it.each([
    'Não precisa se preocupar, tenho 19/11 em Londrina às 13h.',
    '19/11 em Londrina às 13h, não esqueça de levar roupa leve.',
    '18/11 em Ibiporã às 13h, em Londrina não tem vaga em 19/11.',
  ])('negação alheia não desativa a oferta: %s', (texto) => {
    expect(checarDataUnidade([texto], agenda)).toHaveLength(1);
  });
  it('não acusa oferta quando indisponibilidade é explícita sem a palavra não', () => {
    expect(checarDataUnidade(['19/11 em Londrina está indisponível.'], agenda)).toEqual([]);
  });
  it('respeita duas cidades antes das datas na mesma frase, sem ou', () => {
    expect(checarDataUnidade(['Em Londrina 18/11 às 13h, em Ibiporã 19/11 às 11h.'], agenda)).toEqual([]);
  });
  it('herda unidade quando ela está no balão anterior', () => {
    expect(checarDataUnidade(['Em Londrina tenho estas opções:', '19/11 às 13h.'], agenda)).toHaveLength(1);
  });
});

describe('Codex: serviço restrito e semântica do aviso', () => {
  it.each([
    'Tenho dia 19 em Londrina às 13h.',
    'Tenho amanhã em Londrina às 13h30.',
    'Tenho às 13:00 em Londrina.',
  ])('não oferece invertida em Londrina sem aviso, mesmo sem dd/mm: %s', (texto) => {
    expect(servico(texto)).toHaveLength(1);
  });
  it('não confunde menção genérica a quiropraxia com aviso da restrição', () => {
    expect(servico('A terapia invertida funciona junto com a quiropraxia. Tenho 18/11 em Londrina às 13h.')).toHaveLength(1);
  });
  it('não aceita negação da restrição como aviso válido', () => {
    expect(servico('Não é só em Ibiporã, faço a invertida também em Londrina 18/11 às 13h.')).toHaveLength(1);
  });
  it('aviso antigo não autoriza contradizer explicitamente a unidade agora', () => {
    expect(servico('A mesa de inversão tem sim em Londrina, 18/11 às 13h.', [
      'A invertida é só em Ibiporã; em Londrina é quiropraxia, sem a mesa.',
    ])).toHaveLength(1);
  });
  it('não perde assunto de serviço quando a data vem na segunda alternativa sem repetir dd/mm', () => {
    expect(servico('21/11 às 15h em Ibiporã ou às 9h em Londrina.')).toHaveLength(1);
  });
  it('não perde serviço por grafia de cabeça para baixo com hífen', () => {
    expect(servico('18/11 em Londrina às 13h.', [], 'Quero a mesa de cabeça-pra-baixo')).toHaveLength(1);
  });
  it('reconhece aviso correto e oferta só na unidade permitida', () => {
    expect(servico('Em Londrina é quiropraxia, sem a mesa. Tenho 18/11 às 13h.')).toEqual([]);
    expect(servico('19/11 às 13h em Ibiporã.')).toEqual([]);
  });
});

describe('Codex: Unicode e configuração defensiva', () => {
  it('normalização preserva UTF-16 e posição após emoji', () => {
    const texto = '📍 IBIPORÃ 19/11';
    expect(normalizar(texto)).toBe('📍 ibipora 19/11');
    expect(normalizar(texto).indexOf('19/11')).toBe(texto.indexOf('19/11'));
  });
  it('normalização remove acento decomposto no meio de unidade', () => {
    expect(normalizar('Sa\u0303o Paulo')).toBe('sao paulo');
    expect(paresDataUnidade('19/11 em Sa\u0303o Paulo', ['sao paulo'])).toHaveLength(1);
  });
  it('API pública aceita unidades com caixa e acento sem precondição oculta', () => {
    expect(paresDataUnidade('19/11 em IBIPORÃ', ['Londrina', 'Ibiporã'])).toHaveLength(1);
  });
  it('não aceita regex de backtracking exponencial apenas porque compila', () => {
    const c = lerConfig({ modo: 'enforce', servicos: [{ ...invertida, gatilho: '(a+)+$' }] });
    expect(c?.servicos).toEqual([]);
  });
  it('descarta aviso vazio que casaria toda resposta e desligaria a proteção', () => {
    const c = lerConfig({ modo: 'enforce', servicos: [{ ...invertida, aviso: '' }] });
    expect(c?.servicos).toEqual([]);
  });
  it('mantém marcador de mídia intacto e acrescenta aviso no texto', () => {
    const marcador = '[[midia:https://example.invalid/mesa.jpg]]';
    expect(acrescentarAvisos(['Tenho 18/11 em Londrina.', marcador], [invertida])).toEqual([
      `Tenho 18/11 em Londrina.\n${invertida.aviso_texto}`, marcador,
    ]);
  });
  it('lê retorno embrulhado e JSON de topo sem rede', () => {
    const retorno = { data: { data: { available_slots: [{ date: '2026-11-19', slots_por_unidade: [
      { horario: '13:00', unidade: 'Ibiporã' },
    ] }] } } };
    expect(mapaDaAgenda([JSON.stringify(retorno)]).get('19/11')).toEqual(new Set(['ibipora']));
  });
  it('não ignora JSON válido aninhado num campo result textual', () => {
    const retorno = { data: { available_slots: [{ date: '2026-11-19', slots_por_unidade: [
      { horario: '13:00', unidade: 'Ibiporã' },
    ] }] } };
    expect(mapaDaAgenda([{ result: JSON.stringify(retorno) }]).get('19/11')).toEqual(new Set(['ibipora']));
  });
});
