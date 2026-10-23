// Montador único, passo 2: busca no Supabase o que `montarPrompt` precisa, com as mesmas consultas e
// limites que o n8n usa hoje (AGENTE BASE). Só LÊ. Qualquer falha de leitura sobe como exceção: quem
// chama (a sombra) descarta o turno em vez de comparar com entrada incompleta.
//
// Mapa nó do n8n -> consulta aqui:
//   Encontrar_Agente            -> agents (prompt_config, tenant_id)
//   Ler_Treinamentos            -> agent_trainings ativos, created_at asc, limit 100
//   Buscar_Intents_Executadas   -> intent_execution_logs da conversa, created_at desc, limit 20
//   Buscar CRM stages + Pack    -> funnel_stages + leads.crm_stage (mesma regra de routes/stages.ts)
//   Buscar_Inicio_Conversa      -> messages inbound da conversa, created_at asc, limit 4
//   Webhook1 (contact_name)     -> messages.sender_name da última fala do cliente (conferido: igual ao
//                                  contact_name do webhook em 226 de 226 execuções)
//
// QUANDO o n8n lê (medido em 226 execuções de 23/10/2026): intenções e estágio do CRM são lidos na CHEGADA
// do webhook; o n8n então espera o buffer (`prompt_config.delays.max_ms`: 10, 15 ou 30 s) e só depois lê
// treinamentos e início da conversa, ~0,2 s antes de chamar o /api/chat. A sombra roda depois disso, então:
//   - intenções: só entram as anteriores a `recebidoEm - max_ms` (aproximação da chegada do webhook;
//     sem o recuo, um turno anterior da mesma conversa que ainda rodava durante a espera entrava aqui e
//     o n8n não via);
//   - mensagens: anteriores a `recebidoEm`;
//   - estágio atual do lead: é o valor ATUAL da coluna e o próprio turno pode mudá-lo, por isso a carga
//     precisa começar logo que o pedido chega (ver executar-sombra.ts). Mudança feita por outro turno
//     durante a espera do buffer ainda pode divergir: ruído conhecido da sombra.

import { supabase } from '../../services/supabase';
import type {
  EntradaMontador,
  EstagiosCrm,
  LogIntencaoLinha,
  MensagemInicioLinha,
  TreinamentoLinha,
} from './montar-prompt';

export interface ParamsCarga {
  agentId: string;
  conversationId: string;
  leadId: string;
  contatoTelefone: string;
  /** Quando o /api/chat recebeu o pedido. Vira a linha "Horário" e o corte das leituras por data. */
  recebidoEm: Date;
}

/** Só o que se usa do cliente Supabase (deixa os testes injetarem um falso). */
export type DbLeitura = Pick<typeof supabase, 'from'>;

export const LIMITE_TREINAMENTOS = 100;
export const LIMITE_INTENCOES = 20;
export const LIMITE_INICIO = 4;

// ── Estágios do CRM (cópia da regra de src/routes/stages.ts + Pack_Agent_Stages) ──────────

export interface LinhaFunnelStage {
  slug: string;
  agent_id: string | null;
}

const SLUGS_PADRAO = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

/**
 * Estágios que o agente vê: específicos do agente > do tenant (agent_id nulo) > padrão fixo. `new` entra
 * na frente (a rota injeta); `follow_up` sai (o nó Pack_Agent_Stages filtra). `linhas` já vem do banco
 * ordenado por `position`.
 */
export function slugsDisponiveis(linhas: LinhaFunnelStage[] | null | undefined, agentId: string): string[] {
  let escolhidos: string[] = [];
  if (linhas && linhas.length > 0) {
    const doAgente = linhas.filter((s) => s.agent_id === agentId);
    escolhidos = (doAgente.length > 0 ? doAgente : linhas.filter((s) => s.agent_id === null)).map((s) => s.slug);
  }
  if (escolhidos.length === 0) escolhidos = SLUGS_PADRAO;
  return ['new', ...escolhidos].filter((slug) => slug !== 'follow_up');
}

// ── Corte das intenções ───────────────────────────────────────

/** Espera do buffer do n8n (`BufferDelay` = `prompt_config.delays.max_ms / 1000`), em ms; 0 se não houver. */
export function esperaDoBufferMs(promptConfig: Record<string, unknown> | null): number {
  const delays = promptConfig?.delays as { max_ms?: unknown } | null | undefined;
  const ms = Number(delays?.max_ms);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Instante aproximado em que o n8n leu as intenções: a chegada do webhook, uma espera de buffer antes do pedido. */
export function corteDasIntencoes(promptConfig: Record<string, unknown> | null, recebidoEm: Date): Date {
  return new Date(recebidoEm.getTime() - esperaDoBufferMs(promptConfig));
}

// ── Carga ─────────────────────────────────────────────────────

function falha(onde: string, error: { message: string } | null): never {
  throw new Error(`${onde}: ${error?.message ?? 'sem resposta'}`);
}

export async function carregarEntrada(p: ParamsCarga, db: DbLeitura = supabase): Promise<EntradaMontador> {
  // O id entra num filtro `.or(...)` do PostgREST: só caracteres de id (uuid ou id sintético de suíte).
  if (!/^[\w-]+$/.test(p.agentId)) throw new Error('agent_id com formato inesperado');
  const corte = p.recebidoEm.toISOString();

  // 1ª leva: tudo o que não depende do agente lido, em paralelo.
  const [agenteR, treinamentosR, inicioR, nomeR, leadR] = await Promise.all([
    db.from('agents').select('tenant_id, prompt_config').eq('id', p.agentId).maybeSingle(),
    db
      .from('agent_trainings')
      .select('id, name, content, injection_mode, metadata')
      .eq('agent_id', p.agentId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(LIMITE_TREINAMENTOS),
    db
      .from('messages')
      .select('content, created_at')
      .eq('conversation_id', p.conversationId)
      .eq('direction', 'inbound')
      .lte('created_at', corte)
      .order('created_at', { ascending: true })
      .limit(LIMITE_INICIO),
    db
      .from('messages')
      .select('sender_name')
      .eq('conversation_id', p.conversationId)
      .eq('direction', 'inbound')
      .lte('created_at', corte)
      .order('created_at', { ascending: false })
      .limit(1),
    db.from('leads').select('crm_stage').eq('id', p.leadId).maybeSingle(),
  ]);

  if (agenteR.error) falha('agents', agenteR.error);
  if (!agenteR.data) throw new Error(`agents: agente ${p.agentId} não encontrado`);
  if (treinamentosR.error) falha('agent_trainings', treinamentosR.error);
  if (inicioR.error) falha('messages (início)', inicioR.error);
  if (nomeR.error) falha('messages (nome)', nomeR.error);
  if (leadR.error) falha('leads', leadR.error);

  const agente = agenteR.data as { tenant_id: string | null; prompt_config: Record<string, unknown> | null };

  // 2ª leva: o corte das intenções usa o buffer do agente e os estágios usam o tenant dele.
  const [intencoesR, estagiosR] = await Promise.all([
    db
      .from('intent_execution_logs')
      .select('intent_key, success, arguments, created_at')
      .eq('conversation_id', p.conversationId)
      .lt('created_at', corteDasIntencoes(agente.prompt_config, p.recebidoEm).toISOString())
      .order('created_at', { ascending: false })
      .limit(LIMITE_INTENCOES),
    db
      .from('funnel_stages')
      .select('slug, agent_id')
      .eq('tenant_id', agente.tenant_id as string)
      .or(`agent_id.eq.${p.agentId},agent_id.is.null`)
      .order('position', { ascending: true }),
  ]);
  if (intencoesR.error) falha('intent_execution_logs', intencoesR.error);
  if (estagiosR.error) falha('funnel_stages', estagiosR.error);

  const crm: EstagiosCrm = {
    estagioAtual: ((leadR.data as { crm_stage?: string | null } | null)?.crm_stage ?? null) || null,
    estagiosDisponiveis: slugsDisponiveis(estagiosR.data as LinhaFunnelStage[] | null, p.agentId),
  };

  const nomeLinha = (nomeR.data as { sender_name: string | null }[] | null)?.[0];

  return {
    promptConfig: agente.prompt_config,
    treinamentos: (treinamentosR.data ?? []) as TreinamentoLinha[],
    intencoesExecutadas: (intencoesR.data ?? []) as LogIntencaoLinha[],
    crm,
    inicioConversa: (inicioR.data ?? []) as MensagemInicioLinha[],
    contatoNome: nomeLinha?.sender_name ?? null,
    contatoTelefone: p.contatoTelefone,
    agora: p.recebidoEm,
  };
}
