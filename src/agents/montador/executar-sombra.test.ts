import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { logGuardShadow } = vi.hoisted(() => ({ logGuardShadow: vi.fn() }));
vi.mock('../../services/supabase', () => ({ supabase: { from: vi.fn() }, logGuardShadow }));

import {
  iniciarSombraMontador,
  sombraDoMontadorLigada,
  MODO_MONTADOR_SOMBRA,
  registrarEmGuardShadowLogs,
  type DepsSombra,
  type RegistroSombra,
  type TurnoParaSombra,
} from './executar-sombra';
import { montarPrompt, type EntradaMontador } from './montar-prompt';
import { compararComN8n } from './sombra';
import g3 from './__fixtures__/gabarito-3.json';

function entrada(): EntradaMontador {
  const e = g3.entrada as unknown as Omit<EntradaMontador, 'agora'> & { agora: string };
  return { ...e, agora: new Date(e.agora) };
}

const TURNO = (recebido: string): TurnoParaSombra => ({
  agent_id: 'agente-1',
  conversation_id: 'conversa-1',
  lead_id: 'lead-1',
  contact_phone: '5543900000003',
  system_prompt: recebido,
});

/** Espera as promessas soltas (concluir roda sem await). */
const esvaziarFila = () => new Promise((r) => setTimeout(r, 0));

let ambiente: string | undefined;
beforeEach(() => {
  ambiente = process.env.MONTADOR_SOMBRA;
  logGuardShadow.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (ambiente === undefined) delete process.env.MONTADOR_SOMBRA;
  else process.env.MONTADOR_SOMBRA = ambiente;
  vi.restoreAllMocks();
});

describe('MONTADOR_SOMBRA', () => {
  it('sem a variável (ou com outro valor) nada roda: nem a leitura do banco', () => {
    const carregar = vi.fn();
    const registrar = vi.fn();
    delete process.env.MONTADOR_SOMBRA;
    expect(sombraDoMontadorLigada()).toBe(false);
    expect(iniciarSombraMontador(TURNO('x'), { carregar, registrar })).toBeNull();
    for (const v of ['off', 'true', '1', 'ON', '']) {
      process.env.MONTADOR_SOMBRA = v;
      expect(iniciarSombraMontador(TURNO('x'), { carregar, registrar })).toBeNull();
    }
    expect(carregar).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it('com `on` dispara a leitura já no início e só registra quando o turno conclui', async () => {
    process.env.MONTADOR_SOMBRA = 'on';
    const carregar = vi.fn().mockResolvedValue(entrada());
    const registrar = vi.fn().mockResolvedValue(undefined);
    const concluir = iniciarSombraMontador(TURNO(montarPrompt(entrada())), { carregar, registrar });
    expect(concluir).toBeTypeOf('function');
    expect(carregar).toHaveBeenCalledTimes(1);
    expect(carregar.mock.calls[0][0]).toMatchObject({
      agentId: 'agente-1',
      conversationId: 'conversa-1',
      leadId: 'lead-1',
      contatoTelefone: '5543900000003',
    });
    expect(carregar.mock.calls[0][0].recebidoEm).toBeInstanceOf(Date);
    await esvaziarFila();
    expect(registrar).not.toHaveBeenCalled(); // a resposta ainda não saiu

    (concluir as () => void)();
    await esvaziarFila();
    expect(registrar).toHaveBeenCalledTimes(1);
  });
});

describe('veredito registrado', () => {
  async function rodar(recebido: string): Promise<RegistroSombra> {
    process.env.MONTADOR_SOMBRA = 'on';
    const registrar = vi.fn().mockResolvedValue(undefined);
    const deps: DepsSombra = { carregar: async () => entrada(), registrar };
    (iniciarSombraMontador(TURNO(recebido), deps) as () => void)();
    await esvaziarFila();
    expect(registrar).toHaveBeenCalledTimes(1);
    return registrar.mock.calls[0][0] as RegistroSombra;
  }

  it('prompt idêntico -> montador_igual', async () => {
    const r = await rodar(montarPrompt(entrada()));
    expect(r.verdict).toBe('montador_igual');
    expect(r.comparacao.primeiraDiferenca).toBeNull();
  });

  it('só o minuto do horário muda -> montador_igual_sem_horario', async () => {
    const r = await rodar(montarPrompt({ ...entrada(), agora: new Date('2026-10-26T12:01:00.000Z') }));
    expect(r.verdict).toBe('montador_igual_sem_horario');
  });

  it('qualquer outra diferença -> montador_diferente, com trechos e sem o prompt inteiro', async () => {
    const e = entrada();
    const r = await rodar(montarPrompt({ ...e, promptConfig: { ...e.promptConfig, system_prompt: 'OUTRA PERSONA' } }));
    expect(r.verdict).toBe('montador_diferente');
    expect(r.comparacao.trechoMontado.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(r)).not.toContain('# PRÉ-CLASSIFICAÇÃO DA MENSAGEM');
    expect(r).toMatchObject({ agent_id: 'agente-1', conversation_id: 'conversa-1', lead_id: 'lead-1' });
  });
});

describe('falhas nunca chegam ao turno', () => {
  it('leitura do banco falhou: não registra, não lança', async () => {
    process.env.MONTADOR_SOMBRA = 'on';
    const registrar = vi.fn();
    const concluir = iniciarSombraMontador(TURNO('x'), { carregar: () => Promise.reject(new Error('fetch failed')), registrar });
    (concluir as () => void)();
    await esvaziarFila();
    expect(registrar).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[MontadorSombra]'), 'fetch failed');
  });

  it('carregar lança na hora: iniciar devolve null em vez de lançar', () => {
    process.env.MONTADOR_SOMBRA = 'on';
    const r = iniciarSombraMontador(TURNO('x'), {
      carregar: () => {
        throw new Error('boom');
      },
      registrar: vi.fn(),
    });
    expect(r).toBeNull();
  });

  it('registrar lança: engolido', async () => {
    process.env.MONTADOR_SOMBRA = 'on';
    const concluir = iniciarSombraMontador(TURNO(montarPrompt(entrada())), {
      carregar: async () => entrada(),
      registrar: async () => {
        throw new Error('banco fora');
      },
    });
    expect(() => (concluir as () => void)()).not.toThrow();
    await esvaziarFila();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[MontadorSombra]'), 'banco fora');
  });

  it('entrada que quebra o montador: engolido', async () => {
    process.env.MONTADOR_SOMBRA = 'on';
    const registrar = vi.fn();
    const concluir = iniciarSombraMontador(TURNO('x'), {
      carregar: async () => ({ ...entrada(), agora: new Date('invalida') }),
      registrar,
    });
    (concluir as () => void)();
    await esvaziarFila();
    expect(registrar).not.toHaveBeenCalled();
  });
});

describe('gravação em guard_shadow_logs (caminho padrão)', () => {
  it('usa o verdict próprio, guard_mode montador_sombra e a comparação em JSON no único item de tokens', async () => {
    logGuardShadow.mockResolvedValue(undefined);
    const comparacao = compararComN8n('prompt montado', 'prompt diferente');
    await registrarEmGuardShadowLogs({
      agent_id: 'agente-1',
      conversation_id: 'conversa-1',
      lead_id: 'lead-1',
      verdict: 'montador_diferente',
      comparacao,
    });
    expect(logGuardShadow).toHaveBeenCalledTimes(1);
    const p = logGuardShadow.mock.calls[0][0];
    expect(p).toMatchObject({
      agent_id: 'agente-1',
      conversation_id: 'conversa-1',
      lead_id: 'lead-1',
      verdict: 'montador_diferente',
      guard_mode: MODO_MONTADOR_SOMBRA,
      mensagens: [],
      tools_called: [],
    });
    expect(p.tokens).toHaveLength(1);
    expect(JSON.parse(p.tokens[0])).toEqual(comparacao);
  });
});
