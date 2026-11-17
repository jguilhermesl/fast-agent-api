import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acrescentarAvisos, checarDataUnidade, checarServico, confirmacaoDoEvento,
  lerConfig, paresDataUnidade, tirarContradicoes, type MapaAgenda,
} from './trava-unidade';

// Nenhuma credencial real: LLM, executor, banco, fila e Redis são substituídos.
const estado = vi.hoisted(() => ({ expirado: false }));
const llm = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../config', () => ({ config: {
  openaiApiKey: 'teste-sem-rede', anthropicApiKey: 'teste-sem-rede', openrouterApiKey: '',
  supabaseUrl: 'https://exemplo.invalid', supabaseAnonKey: 'teste', supabaseServiceKey: 'teste',
  guardMode: 'shadow', lastroMode: 'enforce', cruzamentoMode: 'off', rajadaMode: 'off',
  atendenteNoInicioMode: 'off', loopRoboMode: 'off',
} }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: llm.create } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = {}; } }));
vi.mock('../services/supabase');
vi.mock('./executor', () => ({ runExecutor: vi.fn() }));
vi.mock('../memory/redis', () => ({
  getHistory: vi.fn().mockResolvedValue([]), appendHistory: vi.fn().mockResolvedValue(undefined),
  lockStore: {}, memoriaStore: {}, getUltimoTurno: vi.fn().mockResolvedValue(null),
  setUltimoTurno: vi.fn().mockResolvedValue(undefined), getPendente: vi.fn().mockResolvedValue(null),
  setPendente: vi.fn().mockResolvedValue(true), delPendente: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/fila', () => ({
  TURN_LOCK_WAIT_MS: 1000,
  entrarNaFila: vi.fn().mockResolvedValue({ token: 'teste', esperouMs: 0, concorrente: false }),
  sairDaFila: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/deadline', async (original) => ({
  ...await original<typeof import('../services/deadline')>(),
  createDeadline: () => ({ expired: () => estado.expirado, remaining: () => estado.expirado ? 0 : 90_000 }),
}));

import * as banco from '../services/supabase';
import { runExecutor } from './executor';
import { runOrchestrator } from './orchestrator';
import { appendHistory } from '../memory/redis';
import type { ChatRequest } from '../types';

const unidades = ['Londrina', 'Ibiporã'];
const agenda: MapaAgenda = new Map([
  ['18/11', new Set(['londrina'])], ['19/11', new Set(['ibipora'])],
]);
// Padrão recomendado no cabeçalho da v2, não o padrão permissivo antigo.
const invertida = {
  gatilho: 'invertid|mesa de invers|suspens|cabeca p(a)?ra baixo|ponta cabeca',
  unidades: ['Ibiporã'], aviso: 'sem a mesa|nao tem (a )?mesa|so (faco |tem )?(a invertida )?em ibipor',
  aviso_texto: 'Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão.',
};
const checar = (texto: string) => checarServico({ mensagens: [texto],
  clientMessage: 'Quero terapia invertida', falasRecentesDoAgente: [], agenda,
  unidades, servicos: [invertida] });
const evento = (dateTime: string) => ({ start: { dateTime }, location: 'Ibiporã' });
const confirmar = (result: unknown) => confirmacaoDoEvento([{ tool: 'google_calendar_criar_evento', result }]);

describe('Codex v2: herança e negação por oferta', () => {
  it.each([
    'Em Londrina tenho 18/11 às 13h ou 19/11 às 14h.',
    'Em Londrina tenho 18/11 às 13h e 19/11 às 14h.',
    'Tenho 19/11 às 13h e 18/11 às 14h em Londrina.',
    'Em Londrina tenho estas opções:\n18/11 às 13h\n19/11 às 14h',
  ])('detecta a oferta errada sem exigir repetição da cidade: %s', (texto) => {
    expect(checarDataUnidade([texto], agenda, unidades)).toHaveLength(1);
  });
  it.each([
    '19/11 em Londrina às 13h não tem estacionamento.',
    'Não tenho Pix, mas tenho 19/11 em Londrina às 13h.',
    '19/11 em Londrina às 13h; não tem estacionamento.',
  ])('negação sobre outro assunto não desativa oferta: %s', (texto) => {
    expect(checarDataUnidade([texto], agenda, unidades)).toHaveLength(1);
  });
  it('preserva datas e cidades explicitadas nos três separadores', () => {
    for (const separador of ['; ', ' ou ', ', em ']) {
      const t = separador === ', em '
        ? 'Em Londrina 18/11 às 13h, em Ibiporã 19/11 às 14h.'
        : `18/11 às 13h em Londrina${separador}19/11 às 14h em Ibiporã.`;
      expect(checarDataUnidade([t], agenda, unidades)).toEqual([]);
      expect(paresDataUnidade(t, unidades)).toHaveLength(2);
    }
  });
  it('cidade depois de vírgula resolve data pendente', () => {
    expect(checarDataUnidade(['Quinta, 19/11, às 13h, em Londrina.'], agenda, unidades)).toHaveLength(1);
  });
});

describe('Codex v2: contradição, aviso e remoção', () => {
  it.each([
    'A invertida é só em Ibiporã, mas agora faço também em Londrina 18/11 às 13h.',
    'Em Ibiporã a sessão é sem a mesa; faço terapia invertida em Londrina 18/11 às 13h.',
    'Não atendo em Ibiporã, mas faço a invertida em Londrina 18/11 às 13h.',
    'Em Ibiporã não tem vaga, em Londrina faço invertida às 13h.',
  ])('aviso ou negação da cidade permitida não encobre contradição: %s', (texto) => {
    expect(checar(texto).some((p) => p.tipo === 'contradicao')).toBe(true);
  });
  it('só mencionar serviço junto da oferta correta em Ibiporã não é contradição em Londrina', () => {
    expect(checar('Tenho 18/11 às 13h em Londrina, ou terapia invertida em Ibiporã 19/11 às 14h.')
      .some((p) => p.tipo === 'contradicao')).toBe(false);
  });
  it('horário de funcionamento genérico não é oferta de vaga', () => {
    expect(checar('Em Londrina eu atendo das 11h às 19h.')).toEqual([]);
  });
  it('tira contradição real sem deixar a mensagem vazia no plano B do orquestrador', () => {
    const problemas = checar('Faço a terapia invertida em Londrina.');
    const limpas = tirarContradicoes(['Faço a terapia invertida em Londrina.'], [invertida], unidades);
    expect(limpas).toEqual([]);
    expect(acrescentarAvisos(limpas, problemas)).toEqual([invertida.aviso_texto]);
  });
  it('remoção preserva a oferta legítima de invertida em Ibiporã na mesma frase', () => {
    const texto = 'Em Londrina faço quiropraxia, em Ibiporã faço a terapia invertida.';
    expect(tirarContradicoes([texto], [invertida], unidades)).toEqual([texto]);
  });
  it('remoção preserva uma restrição correta escrita com não em Londrina', () => {
    const texto = 'A mesa de inversão fica em Ibiporã e não em Londrina.';
    expect(tirarContradicoes([texto], [invertida], unidades)).toEqual([texto]);
  });
});

describe('Codex v2: confirmação deve representar evento válido do turno', () => {
  it('conserva evento explícito com offset brasileiro', () => {
    expect(confirmar({ success: true, data: { event: evento('2026-11-19T13:30:00-03:00') } }))
      .toContain('quinta, 19/11 às 13h30 em Ibiporã');
  });
  it.each([
    ['2026-11-19T01:00:00Z', 'quarta, 18/11 às 22h'],
    ['2026-11-19T16:30:00+00:00', 'quinta, 19/11 às 13h30'],
  ])('converte instante ao fuso da clínica: %s', (iso, esperado) => {
    expect(confirmar({ success: true, data: { event: evento(iso) } })).toContain(esperado);
  });
  it.each([
    { success: false }, { status: 'error' }, { status: 'cancelled' },
  ])('não confirma evento falho ou cancelado: %j', (estadoEvento) => {
    expect(confirmar({ ...estadoEvento, ...evento('2026-11-19T13:00:00-03:00') })).toBeNull();
  });
  it('não transforma uma lista de outros pacientes em evento recém-criado', () => {
    expect(confirmar({ success: true, data: { events: [{ id: 'outro', summary: 'Outro paciente',
      ...evento('2026-11-19T13:00:00-03:00') }] } })).toBeNull();
  });
  it('lê resultado textual de criação quando o evento válido estiver em JSON', () => {
    expect(confirmar(JSON.stringify({ success: true, data: { event: evento('2026-11-19T13:00:00-03:00') } })))
      .toContain('19/11 às 13h');
  });
  it('não confirma data impossível', () => {
    expect(confirmar({ success: true, data: { event: evento('2026-13-40T25:99:00Z') } })).toBeNull();
  });
});

describe('Codex v2: regexSegura não pode aprovar padrões exponenciais', () => {
  it.each(['(a|aa)+$', '((a+))+$'])('rejeita bypass do filtro de quantificador aninhado: %s', (gatilho) => {
    expect(lerConfig({ modo: 'enforce', unidades, servicos: [{ ...invertida, gatilho }] })?.servicos).toEqual([]);
  });
});

const retornoAgenda = { resumo: '18/11 às 13h em Londrina; 19/11 às 13h em Ibiporã', data: { available_slots: [
  { date: '2026-11-18', slots_por_unidade: [{ horario: '13:00', unidade: 'Londrina' }] },
  { date: '2026-11-19', slots_por_unidade: [{ horario: '13:00', unidade: 'Ibiporã' }] },
] } };
const pedido: ChatRequest = {
  agent_id: '204c3466-eb2c-48d9-a7fe-856fbcba3e4d',
  conversation_id: '1306e4c7-50d3-4392-bdb7-d2bfce9ded29', lead_id: 'lead-teste',
  contact_phone: '5581900000000', scoped_client_id: 'teste-local',
  client_messages: 'Quero terapia invertida, quais horários?', client_message_type: 'text',
  model_provider: 'openai', model_name: 'gpt-5.4', system_prompt: 'Você é o Leandro. Invertida só em Ibiporã.',
};
const respostaLlm = (texto: string) => ({ model: 'gpt-5.4', usage: {}, choices: [{
  message: { content: JSON.stringify({ mensagens: [texto], redirect_human: false }) },
}] });

describe('Codex v2: turno completo com dependências simuladas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llm.create.mockReset();
    estado.expirado = false;
    for (const f of Object.values(banco)) if (vi.isMockFunction(f)) f.mockResolvedValue(null);
    vi.mocked(banco.getConfigCotacao).mockResolvedValue({ ligado: false, titulos: {} });
    vi.mocked(banco.buildTokenLogEntry).mockReturnValue({ estimated_cost_usd: 0 } as ReturnType<typeof banco.buildTokenLogEntry>);
    vi.mocked(banco.getTravaUnidade).mockResolvedValue({ modo: 'enforce', unidades, servicos: [invertida] });
    vi.mocked(banco.getAgentIntents).mockResolvedValue([]);
    vi.mocked(banco.getIntentLogsCompletos).mockResolvedValue([]);
    vi.mocked(banco.getEnxergaAtendente).mockResolvedValue(false);
    vi.mocked(banco.getNaoRepetirPergunta).mockResolvedValue(false);
    vi.mocked(runExecutor).mockResolvedValue({ result: JSON.stringify(retornoAgenda), trace: {
      called: true, rounds: 1, model: 'teste', tokens_input: 0, tokens_output: 0, cost_usd: 0,
      tools_called: [{ tool: 'google_calendar_horarios_disponiveis', arguments: {}, result: retornoAgenda }],
    } });
    llm.create.mockResolvedValueOnce({ model: 'gpt-5.4', usage: {}, choices: [{ message: {
      content: null, tool_calls: [{ id: 'consulta', type: 'function', function: { name: 'chamar_executor',
        arguments: JSON.stringify({ tasks: [{ tipo: 'CONSULTA', valor: 'horários' }] }) } }],
    } }] });
  });
  afterEach(() => { estado.expirado = false; });

  it('reescrita de serviço passa novamente pela validação de data/unidade', async () => {
    llm.create.mockResolvedValueOnce(respostaLlm('Faço a terapia invertida em Londrina 18/11 às 13h.'));
    llm.create.mockResolvedValueOnce(respostaLlm('Tenho 19/11 às 13h em Londrina.'));
    const resposta = await runOrchestrator(pedido);
    expect(llm.create).toHaveBeenCalledTimes(3);
    expect(checarDataUnidade(resposta.mensagens, agenda, unidades)).toEqual([]);
  });
  it('prazo expirado após resposta não autoriza entregar uma unidade comprovadamente errada', async () => {
    llm.create.mockImplementationOnce(async () => {
      estado.expirado = true;
      return respostaLlm('Tenho 19/11 às 13h em Londrina.');
    });
    const resposta = await runOrchestrator({ ...pedido, client_messages: 'Quais horários livres?' });
    expect(checarDataUnidade(resposta.mensagens, agenda, unidades)).toEqual([]);
  });
  it('rejeição do log não cala o turno e Redis conserva a resposta final', async () => {
    vi.mocked(banco.logGuardShadow).mockImplementation(async (entrada) => {
      if (entrada.verdict.startsWith('servico_unidade_')) throw new Error('log indisponível');
    });
    llm.create.mockResolvedValueOnce(respostaLlm('Tenho 18/11 às 13h em Londrina.'));
    const resposta = await runOrchestrator(pedido);
    expect(resposta.mensagens.join('\n')).toContain(invertida.aviso_texto);
    expect(appendHistory).toHaveBeenLastCalledWith(expect.any(String), expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: resposta.mensagens.join('\n') }),
    ]));
  });
});
