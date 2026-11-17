/**
 * Terceira revisão independente da trava de unidade (v3, commit 49c1fd0). Teste vermelho = defeito reproduzido.
 * Nenhuma credencial real: LLM, executor, banco, fila e Redis são substituídos (mesmo arranjo do codex2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aplicarSemModelo, checarDataUnidade, checarServico, confirmacaoDoEvento, lerConfig, type MapaAgenda,
} from './trava-unidade';

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
import type { ChatRequest } from '../types';

const unidades = ['Londrina', 'Ibiporã'];
// 18/11 e 20/11 só Londrina; 19/11 só Ibiporã.
const agenda: MapaAgenda = new Map([
  ['18/11', new Set(['londrina'])], ['19/11', new Set(['ibipora'])], ['20/11', new Set(['londrina'])],
]);
// Configuração de produção (prompt_config.trava_unidade do Leandro).
const invertida = {
  gatilho: 'invertid|mesa de invers|suspens|cabeca p(a)?ra baixo|ponta cabeca',
  unidades: ['Ibiporã'], aviso: 'sem a mesa|nao tem (a )?mesa|so (faco |tem )?(a invertida )?em ibipor',
  aviso_texto: 'Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão.',
};
const trava = { modo: 'enforce' as const, unidades, servicos: [invertida] };
const servico = (texto: string) => checarServico({ mensagens: [texto], clientMessage: 'Quero terapia invertida',
  falasRecentesDoAgente: [], agenda, unidades, servicos: [invertida] }).map((p) => p.tipo);
const aplicar = (mensagens: string[], clientMessage = 'Quero terapia invertida', tools: Array<{ tool: string; result: unknown }> = []) =>
  aplicarSemModelo({ mensagens, agenda, trava, clientMessage, falasRecentesDoAgente: [], tools, mensagemPedeDia: 'PEDE_DIA' });
const data = (texto: string) => checarDataUnidade([texto], agenda, unidades).map((v) => `${v.data}@${v.unidade}`);

describe('Revisão 3 · BLOQUEANTE: "também" e "não tem" viram contradição e o plano B apaga resposta certa', () => {
  it.each([
    'Tenho 19/11 às 13h em Ibiporã pra invertida, e também 18/11 às 13h em Londrina.',
    'Faço a invertida em Ibiporã e também atendo em Londrina.',
    'A invertida é só em Ibiporã; em Londrina também atendo, mas sem a mesa.',
    'Em Londrina a invertida não tem, só em Ibiporã.',
  ])('frase correta não é contradição: %s', (texto) => {
    expect(servico(texto)).not.toContain('contradicao');
  });
  it('plano B não apaga a oferta certa de Ibiporã (paciente recebia só o aviso)', () => {
    const r = aplicar(['Tenho 19/11 às 13h em Ibiporã pra invertida, e também 18/11 às 13h em Londrina.']);
    expect(r.mensagens.join('\n')).toContain('19/11 às 13h em Ibiporã');
  });
});

describe('Revisão 3 · BLOQUEANTE: negação nova deixa passar unidade errada', () => {
  it.each([
    // "nao em" (trava-unidade.ts:171) entra na janela da cidade ANTERIOR: Londrina sai negada. A v2 pegava.
    'Fica 19/11 às 13h em Londrina, não em Ibiporã.',
    // OBJ (trava-unidade.ts:165) aceita "como" e "nada", que não são indisponibilidade.
    'Pode vir 19/11 às 13h em Londrina, não tem como errar o endereço.',
    '19/11 às 13h em Londrina não tem nada demais, é só chegar.',
  ])('oferta errada continua acusada: %s', (texto) => {
    expect(data(texto)).toEqual(['19/11@londrina']);
  });
});

describe('Revisão 3 · ALTO: resposta certa trocada por "me fala o dia" (pergunta repetida ao paciente)', () => {
  it.each([
    // Regressão sobre master e v2: "não tenho <data>" deixou de ser negação (OBJ exige vaga/horário/...).
    'Em Londrina não tenho 19/11, mas tenho 18/11 às 13h.',
    'Dia 19/11 em Londrina não vai dar, só em Ibiporã às 13h.',
    'Em Londrina o 19/11 já está cheio; tenho 18/11 às 13h.',
    // Já existia no master: cidade antes da data seguinte é tomada como "depois" da data anterior.
    'Em Londrina tenho 18/11 às 13h e 20/11 às 14h e em Ibiporã 19/11 às 13h.',
  ])('não acusa: %s', (texto) => {
    expect(data(texto)).toEqual([]);
    expect(aplicar([texto], 'oi').mensagens).toEqual([texto]);
  });
});

describe('Revisão 3 · ALTO: vírgula separa cidade do serviço e a contradição passa', () => {
  it.each([
    'Em Londrina, quarta, 18/11, às 13h, faço a invertida.',
    'Em Londrina, às 13h, a gente faz a terapia invertida.',
    'Faço a invertida também, em Londrina.',
  ])('contradição detectada: %s', (texto) => {
    expect(servico(texto)).toContain('contradicao');
  });
  it('"lá" depois de cidade negada: oferta de invertida em Londrina não sai calada', () => {
    expect(servico('Em Londrina não tem vaga hoje, mas faço a invertida lá amanhã às 13h.').length).toBeGreaterThan(0);
  });
  it('mensagem final não diz ao mesmo tempo "faço a invertida" em Londrina e "sem a mesa"', () => {
    const r = aplicar(['Em Londrina, quarta, 18/11, às 13h, faço a invertida.']);
    expect(r.mensagens.join('\n')).not.toMatch(/faço a invertida/);
  });
});

describe('Revisão 3 · MÉDIO: confirmação e regex', () => {
  const ev = { start: { dateTime: '2026-11-19T13:00:00-03:00' }, location: 'Ibiporã' };
  it('criação com "error"/"erro" no envelope não vira "Fechado, tá marcado" (o guard de agendamento não pega "tá marcado")', () => {
    expect(confirmacaoDoEvento([{ tool: 'google_calendar_criar_evento', result: { error: 'Horário ocupado', evento_existente: ev } }])).toBeNull();
    expect(confirmacaoDoEvento([{ tool: 'google_calendar_criar_evento', result: { erro: 'conflito', evento: ev } }])).toBeNull();
  });
  it('regex só com "?" ainda é exponencial: a config não pode aceitar k?^n k^n', () => {
    const gatilho = 'k?'.repeat(28) + 'k'.repeat(28);
    expect(lerConfig({ modo: 'enforce', unidades, servicos: [{ ...invertida, gatilho }] })?.servicos).toEqual([]);
  });
});

describe('Revisão 3 · conferências que devem continuar verdes', () => {
  it('passada final é idempotente: não duplica aviso nem tira de novo', () => {
    for (const msgs of [['Tenho 18/11 às 13h em Londrina.'], ['Faço a invertida em Londrina 18/11 às 13h. Tenho 19/11 às 13h em Ibiporã.']]) {
      const r1 = aplicar(msgs);
      const r2 = aplicar(r1.mensagens);
      expect(r2.feito).toEqual([]);
      expect(r2.mensagens).toEqual(r1.mensagens);
      expect(r1.mensagens.join('\n').split(invertida.aviso_texto)).toHaveLength(2);
    }
  });
  it('pedido do dia (troca por data errada) não ganha aviso solto', () => {
    expect(aplicar(['Tenho 19/11 às 13h em Londrina pra invertida.']).mensagens).toEqual(['PEDE_DIA']);
  });
  it('plano B preserva marcador de mídia e não deixa a resposta vazia', () => {
    const r = aplicar(['[[imagem:mapa]]', 'Faço a invertida em Londrina.']);
    expect(r.mensagens[0]).toBe('[[imagem:mapa]]');
    expect(r.mensagens).toHaveLength(2);
  });
  it('as frases de exemplo do pedido continuam certas', () => {
    expect(servico('Em Londrina, quarta 18/11 às 13h faço a invertida.')).toContain('contradicao');
    expect(data('Tenho quarta, 18/11, em Londrina.')).toEqual([]);
    expect(data('Tenho quarta, 19/11, em Londrina.')).toEqual(['19/11@londrina']);
  });
});

// ── Turno inteiro ──────────────────────────────────────────────
// `resumo` com dd/mm para o guard de lastro achar a fonte das datas (como no retorno real e no codex2).
const retornoAgenda = { resumo: '18/11 às 13h em Londrina; 19/11 às 13h em Ibiporã', data: { available_slots: [
  { date: '2026-11-18', slots_por_unidade: [{ horario: '13:00', unidade: 'Londrina' }] },
  { date: '2026-11-19', slots_por_unidade: [{ horario: '13:00', unidade: 'Ibiporã' }] },
] } };
const pedido: ChatRequest = {
  agent_id: '204c3466-eb2c-48d9-a7fe-856fbcba3e4d',
  conversation_id: '1306e4c7-50d3-4392-bdb7-d2bfce9ded29', lead_id: 'lead-teste',
  contact_phone: '5581900000000', scoped_client_id: 'teste-local-r3',
  client_messages: 'Quero terapia invertida, quais horários?', client_message_type: 'text',
  model_provider: 'openai', model_name: 'gpt-5.4', system_prompt: 'Você é o Leandro. Invertida só em Ibiporã.',
};
const respostaLlm = (texto: string) => ({ model: 'gpt-5.4', usage: {}, choices: [{
  message: { content: JSON.stringify({ mensagens: [texto], redirect_human: false }) },
}] });

describe('Revisão 3 · turno inteiro com dependências simuladas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llm.create.mockReset();
    estado.expirado = false;
    for (const f of Object.values(banco)) if (vi.isMockFunction(f)) f.mockResolvedValue(null);
    vi.mocked(banco.getConfigCotacao).mockResolvedValue({ ligado: false, titulos: {} });
    vi.mocked(banco.buildTokenLogEntry).mockReturnValue({ estimated_cost_usd: 0 } as ReturnType<typeof banco.buildTokenLogEntry>);
    vi.mocked(banco.getTravaUnidade).mockResolvedValue(trava);
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

  it('BLOQUEANTE: sem tempo, resposta certa com "também" chega ao paciente sem a oferta de Ibiporã', async () => {
    llm.create.mockImplementationOnce(async () => {
      estado.expirado = true;
      return respostaLlm('Tenho 19/11 às 13h em Ibiporã pra invertida, e também 18/11 às 13h em Londrina.');
    });
    const resposta = await runOrchestrator(pedido);
    expect(resposta.mensagens.join('\n')).toContain('19/11 às 13h em Ibiporã');
  });

  it('BLOQUEANTE: com tempo, reescrita que mantém o "também" é recusada e o plano B apaga a oferta igual', async () => {
    const certa = 'Tenho 19/11 às 13h em Ibiporã pra invertida, e também 18/11 às 13h em Londrina.';
    llm.create.mockResolvedValueOnce(respostaLlm(certa));
    llm.create.mockResolvedValueOnce(respostaLlm(certa));
    const resposta = await runOrchestrator(pedido);
    // Ajuste do autor (v3.1): sem a falsa contradição do "também" não há reescrita; são 2 chamadas (consulta +
    // resposta). O que o teste protege é a oferta de Ibiporã chegar ao paciente.
    expect(llm.create).toHaveBeenCalledTimes(2);
    expect(resposta.mensagens.join('\n')).toContain('19/11 às 13h em Ibiporã');
  });

  it('aviso sai uma vez só depois das duas passadas (1ª e final)', async () => {
    llm.create.mockResolvedValueOnce(respostaLlm('Tenho 18/11 às 13h em Londrina.'));
    const resposta = await runOrchestrator(pedido);
    expect(resposta.mensagens.join('\n').split(invertida.aviso_texto)).toHaveLength(2);
  });

  it('leitura da config pendurada não segura o turno além do race nem derruba a resposta', async () => {
    vi.mocked(banco.getTravaUnidade).mockReturnValue(new Promise(() => undefined));
    llm.create.mockResolvedValueOnce(respostaLlm('Tenho 18/11 às 13h em Londrina.'));
    const t0 = Date.now();
    const resposta = await runOrchestrator(pedido);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(resposta.mensagens.join('\n')).toContain('18/11 às 13h em Londrina');
  }, 10_000);
});
