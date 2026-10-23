import { describe, it, expect, vi } from 'vitest';

// `services/supabase` cria o cliente no import e `config` exige env: troca o módulo inteiro por um falso.
vi.mock('../../services/supabase', () => ({ supabase: { from: vi.fn() }, logGuardShadow: vi.fn() }));

import {
  carregarEntrada,
  corteDasIntencoes,
  esperaDoBufferMs,
  slugsDisponiveis,
  type DbLeitura,
  type LinhaFunnelStage,
} from './carregar-entrada';

interface Registro {
  tabela: string;
  ops: Array<[string, ...unknown[]]>;
}
type Resposta = { data: unknown; error: { message: string } | null };

/** Cliente falso: grava cada chamada encadeada e responde por `responder(registro)`. */
function dbFalso(responder: (r: Registro) => Resposta) {
  const registros: Registro[] = [];
  const from = (tabela: string) => {
    const reg: Registro = { tabela, ops: [] };
    registros.push(reg);
    const cadeia: unknown = new Proxy(
      {},
      {
        get(_alvo, prop: string) {
          if (prop === 'then') {
            return (ok: (v: Resposta) => unknown, falha: (e: unknown) => unknown) =>
              Promise.resolve(responder(reg)).then(ok, falha);
          }
          return (...args: unknown[]) => {
            reg.ops.push([prop, ...args]);
            return cadeia;
          };
        },
      },
    );
    return cadeia;
  };
  return { db: { from } as unknown as DbLeitura, registros };
}

const ok = (data: unknown): Resposta => ({ data, error: null });
const tem = (r: Registro, ...op: unknown[]) => r.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));
const colunas = (r: Registro) => String(r.ops.find((o) => o[0] === 'select')?.[1]);

const AGENTE = '204c3466-0000-4000-8000-000000000001';
const CONVERSA = '4b7cf6e6-0000-4000-8000-000000000002';
const RECEBIDO = new Date('2026-10-23T21:52:28.742Z');
const PARAMS = { agentId: AGENTE, conversationId: CONVERSA, leadId: CONVERSA, contatoTelefone: '5543900000009', recebidoEm: RECEBIDO };

function respostasNormais(r: Registro): Resposta {
  switch (r.tabela) {
    case 'agents':
      return ok({ tenant_id: 'T1', prompt_config: { system_prompt: 'P', delays: { max_ms: 30000 } } });
    case 'agent_trainings':
      return ok([{ id: '1', name: 'A', content: 'x', injection_mode: 'always', metadata: {} }]);
    case 'intent_execution_logs':
      return ok([{ intent_key: 'k', success: true, arguments: null, created_at: '2026-10-23T21:51:00+00:00' }]);
    case 'messages':
      return colunas(r) === 'sender_name' ? ok([{ sender_name: 'maria teste' }]) : ok([{ content: 'oi', created_at: '2026-10-23T21:40:00+00:00' }]);
    case 'leads':
      return ok({ crm_stage: 'qualified' });
    case 'funnel_stages':
      return ok([
        { slug: 'lead', agent_id: null },
        { slug: 'qualified', agent_id: null },
      ]);
    default:
      throw new Error('tabela inesperada ' + r.tabela);
  }
}

describe('slugsDisponiveis (regra de routes/stages.ts + Pack_Agent_Stages)', () => {
  const doAgente: LinhaFunnelStage[] = [
    { slug: 'a1', agent_id: AGENTE },
    { slug: 't1', agent_id: null },
    { slug: 'a2', agent_id: AGENTE },
    { slug: 'x', agent_id: 'outro-agente' },
  ];

  it('específicos do agente têm prioridade sobre os do tenant, e `new` vem na frente', () => {
    expect(slugsDisponiveis(doAgente, AGENTE)).toEqual(['new', 'a1', 'a2']);
  });

  it('sem específicos usa os do tenant (agent_id nulo)', () => {
    expect(slugsDisponiveis([{ slug: 't1', agent_id: null }, { slug: 't2', agent_id: null }], AGENTE)).toEqual(['new', 't1', 't2']);
  });

  it('sem nada no banco cai no padrão fixo (mesma lista que o n8n recebe hoje)', () => {
    const padrao = ['new', 'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    expect(slugsDisponiveis([], AGENTE)).toEqual(padrao);
    expect(slugsDisponiveis(null, AGENTE)).toEqual(padrao);
    expect(slugsDisponiveis(undefined, AGENTE)).toEqual(padrao);
    expect(slugsDisponiveis([{ slug: 'so-de-outro', agent_id: 'outro-agente' }], AGENTE)).toEqual(padrao);
  });

  it('`follow_up` nunca aparece, venha de onde vier', () => {
    expect(slugsDisponiveis([{ slug: 'follow_up', agent_id: null }, { slug: 't1', agent_id: null }], AGENTE)).toEqual(['new', 't1']);
  });
});

describe('corte das intenções (o n8n lê na chegada do webhook, uma espera de buffer antes do pedido)', () => {
  it('espera = prompt_config.delays.max_ms; ausente, inválida ou negativa = 0', () => {
    expect(esperaDoBufferMs({ delays: { max_ms: 15000 } })).toBe(15000);
    expect(esperaDoBufferMs({ delays: { max_ms: '10000' } })).toBe(10000);
    expect(esperaDoBufferMs({ delays: {} })).toBe(0);
    expect(esperaDoBufferMs({ delays: { max_ms: -5 } })).toBe(0);
    expect(esperaDoBufferMs({ delays: { max_ms: 'abc' } })).toBe(0);
    expect(esperaDoBufferMs({})).toBe(0);
    expect(esperaDoBufferMs(null)).toBe(0);
  });

  it('o corte recua a espera a partir do instante do pedido', () => {
    expect(corteDasIntencoes({ delays: { max_ms: 30000 } }, RECEBIDO).toISOString()).toBe('2026-10-23T21:51:58.742Z');
    expect(corteDasIntencoes(null, RECEBIDO).toISOString()).toBe(RECEBIDO.toISOString());
  });
});

describe('carregarEntrada', () => {
  it('faz as mesmas consultas do n8n, com os mesmos filtros, ordem e limites', async () => {
    const { db, registros } = dbFalso(respostasNormais);
    await carregarEntrada(PARAMS, db);
    const por = (tabela: string) => registros.filter((r) => r.tabela === tabela);

    const [agente] = por('agents');
    expect(colunas(agente)).toBe('tenant_id, prompt_config');
    expect(tem(agente, 'eq', 'id', AGENTE)).toBe(true);

    const [treino] = por('agent_trainings');
    expect(tem(treino, 'eq', 'agent_id', AGENTE)).toBe(true);
    expect(tem(treino, 'eq', 'status', 'active')).toBe(true);
    expect(tem(treino, 'order', 'created_at', { ascending: true })).toBe(true);
    expect(tem(treino, 'limit', 100)).toBe(true);

    const [logs] = por('intent_execution_logs');
    expect(tem(logs, 'eq', 'conversation_id', CONVERSA)).toBe(true);
    // corte = chegada do pedido menos a espera do buffer do agente (30 s): é quando o n8n leu as intenções
    expect(tem(logs, 'lt', 'created_at', '2026-10-23T21:51:58.742Z')).toBe(true);
    expect(tem(logs, 'order', 'created_at', { ascending: false })).toBe(true);
    expect(tem(logs, 'limit', 20)).toBe(true);

    const mensagens = por('messages');
    expect(mensagens).toHaveLength(2);
    const inicio = mensagens.find((r) => colunas(r) === 'content, created_at') as Registro;
    expect(tem(inicio, 'eq', 'direction', 'inbound')).toBe(true);
    expect(tem(inicio, 'lte', 'created_at', '2026-10-23T21:52:28.742Z')).toBe(true);
    expect(tem(inicio, 'order', 'created_at', { ascending: true })).toBe(true);
    expect(tem(inicio, 'limit', 4)).toBe(true);
    const nome = mensagens.find((r) => colunas(r) === 'sender_name') as Registro;
    expect(tem(nome, 'eq', 'direction', 'inbound')).toBe(true);
    expect(tem(nome, 'order', 'created_at', { ascending: false })).toBe(true);
    expect(tem(nome, 'limit', 1)).toBe(true);

    const [lead] = por('leads');
    expect(tem(lead, 'eq', 'id', CONVERSA)).toBe(true);

    const [funil] = por('funnel_stages');
    expect(tem(funil, 'eq', 'tenant_id', 'T1')).toBe(true);
    expect(tem(funil, 'or', `agent_id.eq.${AGENTE},agent_id.is.null`)).toBe(true);
    expect(tem(funil, 'order', 'position', { ascending: true })).toBe(true);
  });

  it('monta a entrada: config, base, intenções, CRM, início, nome do remetente, telefone e instante', async () => {
    const { db } = dbFalso(respostasNormais);
    const e = await carregarEntrada(PARAMS, db);
    expect(e.promptConfig).toEqual({ system_prompt: 'P', delays: { max_ms: 30000 } });
    expect(e.treinamentos).toHaveLength(1);
    expect(e.intencoesExecutadas).toHaveLength(1);
    expect(e.crm).toEqual({ estagioAtual: 'qualified', estagiosDisponiveis: ['new', 'lead', 'qualified'] });
    expect(e.inicioConversa).toEqual([{ content: 'oi', created_at: '2026-10-23T21:40:00+00:00' }]);
    expect(e.contatoNome).toBe('maria teste');
    expect(e.contatoTelefone).toBe('5543900000009');
    expect(e.agora).toBe(RECEBIDO);
  });

  it('sem fala do cliente, sem lead ou sem estágio no banco: segue com vazio, não quebra', async () => {
    const { db } = dbFalso((r) => {
      if (r.tabela === 'messages' && colunas(r) === 'sender_name') return ok([]);
      if (r.tabela === 'leads') return ok(null);
      if (r.tabela === 'funnel_stages') return ok([]);
      return respostasNormais(r);
    });
    const e = await carregarEntrada(PARAMS, db);
    expect(e.contatoNome).toBeNull();
    expect(e.crm?.estagioAtual).toBeNull();
    expect(e.crm?.estagiosDisponiveis).toEqual(['new', 'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
  });

  it('erro de leitura em qualquer consulta rejeita (a sombra descarta o turno em vez de comparar às cegas)', async () => {
    for (const tabela of ['agents', 'agent_trainings', 'intent_execution_logs', 'messages', 'leads', 'funnel_stages']) {
      const { db } = dbFalso((r) => (r.tabela === tabela ? { data: null, error: { message: 'timeout' } } : respostasNormais(r)));
      await expect(carregarEntrada(PARAMS, db)).rejects.toThrow(/timeout/);
    }
  });

  it('agente inexistente rejeita', async () => {
    const { db } = dbFalso((r) => (r.tabela === 'agents' ? ok(null) : respostasNormais(r)));
    await expect(carregarEntrada(PARAMS, db)).rejects.toThrow(/não encontrado/);
  });

  it('agent_id com caracteres de filtro é recusado antes de qualquer consulta', async () => {
    const { db, registros } = dbFalso(respostasNormais);
    await expect(carregarEntrada({ ...PARAMS, agentId: 'x,agent_id.is.null' }, db)).rejects.toThrow(/formato/);
    expect(registros).toHaveLength(0);
  });
});
