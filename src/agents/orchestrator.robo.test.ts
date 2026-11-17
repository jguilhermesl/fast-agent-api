import { describe, it, expect, vi, beforeEach } from 'vitest';

// Turno inteiro (`runOrchestrator`) até a trava de robô, com banco, Redis e LLM simulados.
// As funções de decisão têm teste próprio (loop-robo.test.ts); aqui a prova é a ligação:
// com robô do outro lado o turno devolve `mensagens: []` sem ler o histórico nem chamar LLM,
// e com gente o turno passa da trava. Card #1223 (17/11/2026).

const estado = vi.hoisted(() => ({
  loopRoboMode: 'pausar' as 'pausar' | 'log' | 'off',
  atendenteNoInicioMode: 'calar' as 'calar' | 'log' | 'off',
}));
const llm = vi.hoisted(() => ({ openai: vi.fn(), anthropic: vi.fn() }));

vi.mock('../config', () => ({
  config: {
    port: 3000,
    apiSecret: 'segredo-teste',
    openaiApiKey: 'sk-teste',
    anthropicApiKey: 'sk-ant-teste',
    openrouterApiKey: '',
    supabaseUrl: 'https://exemplo.supabase.co',
    supabaseAnonKey: 'anon-teste',
    supabaseServiceKey: 'service-teste',
    redisUrl: 'redis://localhost:6379',
    webhookSecret: 'segredo-teste',
    zapiClientToken: '',
    guardMode: 'shadow',
    lastroMode: 'off',
    cruzamentoMode: 'off',
    rajadaMode: 'off',
    get atendenteNoInicioMode() { return estado.atendenteNoInicioMode; },
    get loopRoboMode() { return estado.loopRoboMode; },
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: llm.openai } };
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: llm.anthropic, stream: llm.anthropic };
  },
}));

vi.mock('../memory/redis', () => ({
  getHistory: vi.fn(),
  appendHistory: vi.fn(),
  lockStore: {},
  memoriaStore: {},
  getUltimoTurno: vi.fn().mockResolvedValue(null),
  setUltimoTurno: vi.fn().mockResolvedValue(undefined),
  getPendente: vi.fn().mockResolvedValue(null),
  setPendente: vi.fn().mockResolvedValue(true),
  delPendente: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/fila', () => ({
  TURN_LOCK_WAIT_MS: 1000,
  entrarNaFila: vi.fn().mockResolvedValue({ token: 'vez-teste', esperouMs: 0, concorrente: false }),
  sairDaFila: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./executor', () => ({ runExecutor: vi.fn() }));
vi.mock('../services/supabase');

import { runOrchestrator } from './orchestrator';
import { getHistory, appendHistory } from '../memory/redis';
import { runExecutor } from './executor';
import {
  getEstadoDoLead,
  getMemoriaPorConversa,
  getMensagensRecebidasDesde,
  getUltimasMensagensDaConversa,
  logGuardShadow,
} from '../services/supabase';
import * as banco from '../services/supabase';
import type { MensagemDaConversa } from './rajada';
import type { ChatRequest } from '../types';

const CONVERSA = '1306e4c7-50d3-4392-bdb7-d2bfce9ded29';
const AGORA = Date.now();
let relogio = 0;
const em = (direction: 'inbound' | 'outbound', content: string, sender_name: string | null = null): MensagemDaConversa => ({
  created_at: new Date(AGORA - 600_000 + relogio++ * 20_000).toISOString(),
  direction,
  message_type: 'text',
  content,
  sender_name,
  from_device: false,
});

const FINALIZADO = 'Atendimento finalizado, agradecemos o contato';
const BOAS_VINDAS = 'Seja bem-vindo a central de atendimento da *B4 TELECOM*🚀🚀🚀\n\nPara iniciarmos seu atendimento, por favor me informe *seu nome*.';

/** A conversa real de 28/10/2026 até a 2ª mensagem do atendimento automático. */
function conversaB4(): MensagemDaConversa[] {
  relogio = 0;
  return [
    em('inbound', 'Aqui é a Sabrina da B4 TELECOM, gostaria de saber os valores dos exames asu'),
    em('outbound', 'Bom dia, Sabrina! Para o ASO, é preciso informar a razão social da empresa.'),
    em('inbound', 'estou esperando a resposta da diretoria'),
    em('outbound', 'Sem problema, Sabrina.'),
    em('inbound', 'agradeço.'),
    em('outbound', 'Por nada, Sabrina!'),
    em('inbound', FINALIZADO),
    em('outbound', 'Combinado, Sabrina. Quando a diretoria responder, é só me chamar.'),
    em('inbound', BOAS_VINDAS),
  ];
}

const recebidasDe = (linha: MensagemDaConversa[]) =>
  linha.filter((m) => m.direction === 'inbound').reverse().map((m) => ({ message_type: m.message_type, content: m.content, created_at: m.created_at }));

function pedido(texto: string): ChatRequest {
  return {
    agent_id: '45bc75c9-71fc-46cd-ace6-f3d364f3bb4a',
    conversation_id: CONVERSA,
    lead_id: CONVERSA,
    contact_phone: '5585900000000',
    client_messages: texto,
    client_message_type: 'text',
    system_prompt: 'Você é a Duda.',
    model_provider: 'anthropic',
    model_name: 'claude-sonnet-5-5',
  } as unknown as ChatRequest;
}

const PASSOU = new Error('PASSOU_DA_TRAVA');

/** Roda o turno; o histórico do Redis é o primeiro passo depois da trava e aqui estoura de propósito. */
async function rodar(req: ChatRequest) {
  try {
    return { resposta: await runOrchestrator(req), erro: null as unknown };
  } catch (erro) {
    return { resposta: null, erro };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.loopRoboMode = 'pausar';
  estado.atendenteNoInicioMode = 'calar';
  // Toda leitura do banco responde vazio por padrão: o código de depois da trava encadeia `.catch` nelas.
  for (const f of Object.values(banco)) {
    if (vi.isMockFunction(f)) f.mockResolvedValue(null);
  }
  vi.mocked(getMemoriaPorConversa).mockResolvedValue(false);
  vi.mocked(getEstadoDoLead).mockResolvedValue({ handled_by: 'ai', status: 'open', ai_disabled: false });
  vi.mocked(logGuardShadow).mockResolvedValue(undefined);
  vi.mocked(getHistory).mockRejectedValue(PASSOU);
});

describe('turno com robô do outro lado (ligação no orquestrador)', () => {
  it('B4: 2ª mensagem automática seguida pausa o turno sem histórico, sem executor e sem LLM', async () => {
    const linha = conversaB4();
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(linha);
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(linha));

    const { resposta, erro } = await rodar(pedido(BOAS_VINDAS));

    expect(erro).toBeNull();
    expect(resposta?.mensagens).toEqual([]);
    expect(resposta?.redirect_human).toBe(false);
    expect(resposta?.transfer_reason).toBeUndefined();
    expect(logGuardShadow).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: CONVERSA,
      verdict: 'loop_robo_pausado',
      tokens: ['automaticas', 'textos=2', 'distintos=2'],
      guard_mode: 'pausar',
    }));
    expect(getHistory).not.toHaveBeenCalled();
    expect(appendHistory).not.toHaveBeenCalled();
    expect(runExecutor).not.toHaveBeenCalled();
    expect(llm.openai).not.toHaveBeenCalled();
    expect(llm.anthropic).not.toHaveBeenCalled();
    // A leitura das últimas mensagens é a do bloco do atendente: uma só, sem consulta nova.
    expect(getUltimasMensagensDaConversa).toHaveBeenCalledTimes(1);
  });

  it('B4: a 1ª mensagem automática ainda passa da trava', async () => {
    const linha = conversaB4().slice(0, 7);
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(linha);
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(linha));

    const { erro } = await rodar(pedido(FINALIZADO));

    expect(erro).toBe(PASSOU);
    expect(logGuardShadow).not.toHaveBeenCalled();
  });

  it('a pessoa voltou a escrever depois do robô: o turno passa da trava', async () => {
    const linha = [...conversaB4(), em('inbound', 'Oi, a diretoria aprovou, pode agendar para quinta')];
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(linha);
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(linha));

    const { erro } = await rodar(pedido('Oi, a diretoria aprovou, pode agendar para quinta'));

    expect(erro).toBe(PASSOU);
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(logGuardShadow).not.toHaveBeenCalled();
  });

  it('LOOP_ROBO_MODE=log: registra como detectado e o turno segue', async () => {
    estado.loopRoboMode = 'log';
    const linha = conversaB4();
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(linha);
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(linha));

    const { erro } = await rodar(pedido(BOAS_VINDAS));

    expect(erro).toBe(PASSOU);
    expect(logGuardShadow).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'loop_robo_detectado', guard_mode: 'log' }));
  });

  it('LOOP_ROBO_MODE=off: nem consulta as mensagens recebidas', async () => {
    estado.loopRoboMode = 'off';
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(conversaB4());

    const { erro } = await rodar(pedido(BOAS_VINDAS));

    expect(erro).toBe(PASSOU);
    expect(getMensagensRecebidasDesde).not.toHaveBeenCalled();
    expect(logGuardShadow).not.toHaveBeenCalled();
  });

  it('bloco do atendente desligado: a trava lê as últimas mensagens por conta própria e pausa', async () => {
    estado.atendenteNoInicioMode = 'off';
    const linha = conversaB4();
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(linha);
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(linha));

    const { resposta } = await rodar(pedido(BOAS_VINDAS));

    expect(resposta?.mensagens).toEqual([]);
    expect(getUltimasMensagensDaConversa).toHaveBeenCalledTimes(1);
  });

  it('leitura das últimas mensagens falha: as regras de repetição continuam valendo', async () => {
    const CLARO = 'Em caso de dúvidas ou para mais informações, acesse sua conta: https://minhaclaro.claro.com.br/acesso-rapido/';
    vi.mocked(getUltimasMensagensDaConversa).mockRejectedValue(new Error('banco fora'));
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ message_type: 'text', content: CLARO, created_at: new Date(AGORA - i * 60_000).toISOString() })),
    );

    const { resposta } = await rodar(pedido(CLARO));

    expect(resposta?.mensagens).toEqual([]);
    expect(logGuardShadow).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'loop_robo_pausado', tokens: ['repeticao', 'textos=10', 'distintos=1'] }));
  });

  it('leitura das últimas mensagens falha e não há repetição: o turno segue', async () => {
    vi.mocked(getUltimasMensagensDaConversa).mockRejectedValue(new Error('banco fora'));
    vi.mocked(getMensagensRecebidasDesde).mockResolvedValue(recebidasDe(conversaB4()));

    const { erro } = await rodar(pedido(BOAS_VINDAS));

    expect(erro).toBe(PASSOU);
    expect(logGuardShadow).not.toHaveBeenCalled();
  });

  it('conversa de suíte (id que não é UUID) não consulta o banco nem pausa', async () => {
    vi.mocked(getUltimasMensagensDaConversa).mockResolvedValue(conversaB4());

    const { erro } = await rodar({ ...pedido(BOAS_VINDAS), conversation_id: 'suite-teste-b4' } as ChatRequest);

    expect(erro).toBe(PASSOU);
    expect(getUltimasMensagensDaConversa).not.toHaveBeenCalled();
    expect(getMensagensRecebidasDesde).not.toHaveBeenCalled();
  });
});
