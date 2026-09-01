// ============================================================
// Guard de agendamento — impede "agendamento fantasma"
// ============================================================
//
// O Orquestrador às vezes confirma o horário ao cliente sem mandar a task de
// AGENDAMENTO ao Executor. O cliente recebe "seu horário ficou para quinta,
// 20/08 às 12h", vai até a unidade, e não existe evento nenhum na agenda.
// (Caso real: lead 58c7d6fc, agente Leandro, 20/08/2026 — o turno mandou uma
// única task tipo CRM.)
//
// Este módulo roda depois que a resposta já está pronta e antes de ela sair.
// Quando a resposta afirma que o horário está marcado e nenhuma intent de
// criação rodou, ele mesmo cria o evento a partir da data/hora do texto. O
// cliente não percebe nada e ninguém precisa assumir a conversa.
//
// Custo no caminho feliz: zero. Nada aqui toca a rede antes de o texto casar
// um padrão de confirmação — o que acontece em ~2% dos turnos.
//
// Falha-aberto por princípio: qualquer erro inesperado deixa a resposta seguir
// como estava. Um bug aqui nunca pode calar o agente.

import type { AgentIntent, IntentLog, ToolCallLog } from '../types';

// `handlers` é carregado sob demanda: ele puxa `config`, que exige as env vars do
// servidor. Import estático faria as funções puras deste módulo (e o teste delas)
// dependerem de um ambiente completo sem precisar.
type ExecutarIntent = (
  args: { intent_key: string; arguments: Record<string, unknown> },
  ctx: { agent_id: string; conversation_id: string }
) => Promise<string>;

async function executarIntentPadrao(
  ...args: Parameters<ExecutarIntent>
): ReturnType<ExecutarIntent> {
  const { handleExecutarIntent } = await import('../tools/handlers');
  return handleExecutarIntent(...args);
}

// ── Quais slugs criam compromisso ─────────────────────────────
// Casa as convenções em uso: google_calendar_criar_evento (Leandro, Dani,
// Lidiane) e realizar_agendamento (Duda, Carol).

export const SLUG_CRIACAO_RE =
  /criar_evento|create_event|realizar_agendament|agendar_(consulta|servico|serviço|horario|horário|sessao|sessão)/i;

// Quais desses o guard sabe REPARAR sozinho.
//
// O reparo monta `{action:'create_event', startDateTime}` — o contrato do
// calendar-proxy (Leandro, Dani, Lidiane). `realizar_agendamento` (Duda, Carol) é
// outro contrato: exige `nome`, `data`, `especialidade`, `valor` e `doutor`, que
// o guard não tem como inventar — e inventar aqui seria repetir o defeito que ele
// existe para impedir. Nesses agentes o guard DETECTA e registra, sem tocar a
// rede e sem mexer na resposta do cliente. A decisão do que fazer com o sinal
// vem depois, com a medição em `guard_shadow_logs`.
const SLUG_REPARAVEL_RE = /criar_evento|create_event/i;

const SLUG_SLOTS_RE = /horarios_disponiveis|horários_disponíveis|available_slots|listar_horarios/i;

// ── Detecção de confirmação ──────────────────────────────────
// Só afirmação de que JÁ está marcado. "Posso confirmar esse horário?" e
// "quer que eu agende?" são pergunta, não confirmação — ficam de fora.

const AFIRMACAO_RE = [
  /seu hor[áa]rio (ficou|est[áa]|foi)/i,
  /hor[áa]rio (confirmado|reservado|garantido)/i,
  // Só passado/perfectivo. "fica reservada" é presente genérico e aparece em
  // proposta condicional ("se conseguir se organizar, ela fica reservada").
  /(est[áa]|ficou|foi) (tudo )?(agendad|confirmad|marcad|reservad)[oa]/i,
  /agendamento (est[áa] )?(confirmad|realizad|feit)[oa]/i,
  /consulta (est[áa]|ficou|foi) (agendad|marcad|confirmad)[oa]/i,
  // "Sua consulta com Dr. X ficou para 01/09/2026" — a frase de confirmação
  // PADRÃO da LP Saúde, que nenhum padrão acima alcançava: o sujeito e o verbo
  // ficam separados pelo nome do profissional, e o complemento é "para <data>",
  // não "agendada". Medido em 01/09/2026: `afirmaAgendamento` devolvia false
  // para o texto exato que o cliente recebe, ou seja, o guard nunca rodava nesse
  // tenant — e o motivo NÃO era a exclusão de "por ordem de chegada".
  /\bsua (consulta|sess[ãa]o|avalia[çc][ãa]o|cirurgia|visita|reserva)[^.!?\n]{0,80}\b(ficou|est[áa]|foi)\s+(para|pra|em|no dia|agendad|marcad|confirmad)/i,
  /(agendei|marquei|reservei|confirmei) (seu|o seu|sua|a sua|pra voc[êe]|para voc[êe])/i,
  /te espero (hoje|amanh[ãa]|na|no|dia|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)/i,
  /nos vemos (hoje|amanh[ãa]|na|no|dia|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)/i,
];

// Frases que parecem confirmação mas não são. Cada grupo saiu de um falso
// positivo real no replay de 30 dias de tráfego (23.610 mensagens).
const NAO_E_AFIRMACAO_RE = [
  // Proposta ainda em aberto
  /posso (confirmar|agendar|marcar|reservar|deixar)/i,
  /quer que eu (confirme|agende|marque|reserve)/i,
  /gostaria de (confirmar|agendar|marcar)/i,
  /deseja (confirmar|agendar|marcar)/i,
  /(confirmo|agendo|marco) (pra|para) voc[êe]\?/i,
  /posso j[áa] (garantir|reservar|deixar|segurar|separar)/i,
  /sem compromisso/i,
  /(para|pra) (deixar|dar|ter) o agendamento confirmado/i,

  // Negação — "ainda não ficou confirmado", "não apareceu confirmação"
  /\b(n[ãa]o)\s+\w{0,12}\s*(ficou|est[áa]|esta|foi|apareceu|consegui|deu|há|ha)\b/i,
  /ainda n[ãa]o/i,

  // Referência a agendamento que já existia antes deste turno
  /\bj[áa]\s+(est[áa]|ficou|foi|se encontra)/i,
  /\bque j[áa] est[áa] confirmad/i,

  // Explicação de política de atendimento, não confirmação de um horário.
  // Estreitado em 01/09/2026: o padrão largo `/por ordem de chegada/i` desarmava
  // o guard na frase de confirmação PADRÃO da LP Saúde ("Sua consulta ficou para
  // 01/09. • Atendimento por ordem de chegada, chegue um pouco antes") — ou seja,
  // o guard estava desligado para o tenant inteiro. Agora só casa a política dita
  // como fato isolado ("o atendimento é por ordem de chegada"), que é o falso
  // positivo que o padrão original queria cobrir.
  /(atendimento|consulta|agendamento|marca[çc][ãa]o)\s+(é|e|ser[áa]|fica|funciona)\s+(sempre\s+)?(por\s+)?ordem de chegada/i,
  /o funcionamento [ée]/i,

  // Pedido de dado que falta
  /me (envia|manda|informa|passa)\b/i,
];

// Aviso interno para a equipe (o agente Dani manda um por agendamento da LP Saúde,
// hoje por send-external, fora deste caminho). É relatório sobre um agendamento que
// já existe em outra conversa — criar evento a partir dele duplicaria a agenda.
const RELATORIO_INTERNO_RE = [
  /nome do (cliente|paciente)\s*:/i,
  /\*?cliente\*?\s*:\s*\S/i,
  /\*?whatsapp\*?\s*:\s*\d/i,
  /aten[çc][ãa]o\s*:/i,
  /transfer[êe]ncia de atendimento/i,
  /^conversa encerrada\s*:/i,
];

// O ponto de "Dr." conta como fim de frase para as regex abaixo, que usam
// `[^.!?\n]` para não atravessar sentença. Sem tirar essas abreviações,
// "Sua consulta com Dr. João Silva ficou para 01/09" não casava — o guard
// simplesmente não via a confirmação padrão da LP Saúde.
function semAbreviacoes(texto: string): string {
  return texto.replace(/\b(dr|dra|sr|sra|prof|profa)\./gi, '$1');
}

export function afirmaAgendamento(mensagens: string[]): boolean {
  const texto = semAbreviacoes(mensagens.join('\n'));
  if (!texto.trim()) return false;
  if (NAO_E_AFIRMACAO_RE.some((r) => r.test(texto))) return false;
  if (RELATORIO_INTERNO_RE.some((r) => r.test(texto))) return false;
  return AFIRMACAO_RE.some((r) => r.test(texto));
}

// ── Extração de data e hora do texto de confirmação ──────────

export interface DataHora {
  iso: string;              // "2026-08-20T12:00:00" — sem offset, o proxy aplica o timezone do agente
  unidade?: string;         // local, quando o texto trouxer
}

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, segunda: 1, terça: 2, terca: 2, quarta: 3, quinta: 4, sexta: 5, sábado: 6, sabado: 6,
};

function hojeEmSaoPaulo(agora: Date): { ano: number; mes: number; dia: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(agora);
  const get = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  return { ano: get('year'), mes: get('month'), dia: get('day') };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Extrai a hora. Aceita "12h", "12h30", "12:00", "às 9", "9 horas". */
function extrairHora(texto: string): { hora: number; minuto: number } | null {
  const padroes: Array<{ re: RegExp; h: number; m?: number }> = [
    { re: /(\d{1,2})\s*[:h]\s*(\d{2})\b/i, h: 1, m: 2 },
    { re: /(\d{1,2})\s*h\b/i, h: 1 },
    { re: /[àa]s\s+(\d{1,2})\b(?!\s*\/)/i, h: 1 },
    { re: /(\d{1,2})\s*horas?\b/i, h: 1 },
  ];
  for (const p of padroes) {
    const m = texto.match(p.re);
    if (!m) continue;
    const hora = Number(m[p.h]);
    const minuto = p.m ? Number(m[p.m]) : 0;
    if (hora > 23 || minuto > 59) continue;
    return { hora, minuto };
  }
  return null;
}

/** Extrai a data. Aceita "20/08", "20/08/2026", "20 de agosto", "hoje", "amanhã" e dia da semana. */
function extrairData(texto: string, agora: Date): { ano: number; mes: number; dia: number } | null {
  const hoje = hojeEmSaoPaulo(agora);

  const numerica = texto.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numerica) {
    const dia = Number(numerica[1]);
    const mes = Number(numerica[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      let ano = numerica[3] ? Number(numerica[3]) : hoje.ano;
      if (ano < 100) ano += 2000;
      // Ano ausente e data já passou há mais de 30 dias → é do ano que vem.
      if (!numerica[3] && diasDeDiferenca({ ano, mes, dia }, hoje) < -30) ano += 1;
      return { ano, mes, dia };
    }
  }

  const porExtenso = texto.match(/\b(\d{1,2})\s+de\s+([a-zç]+)/i);
  if (porExtenso) {
    const dia = Number(porExtenso[1]);
    const mes = MESES[porExtenso[2].toLowerCase()];
    if (mes && dia >= 1 && dia <= 31) {
      let ano = hoje.ano;
      if (diasDeDiferenca({ ano, mes, dia }, hoje) < -30) ano += 1;
      return { ano, mes, dia };
    }
  }

  // `\b` depois de "ã" nunca casa: em JS a fronteira de palavra só enxerga
  // [A-Za-z0-9_], então "amanhã " não tem boundary após o "ã".
  if (/\bhoje\b/i.test(texto)) return hoje;
  if (/\bamanh[ãa](?![\wÀ-ÿ])/i.test(texto)) return somarDias(hoje, 1);

  // Dia da semana sozinho: o próximo que vier (hoje conta).
  for (const [nome, alvo] of Object.entries(DIAS_SEMANA)) {
    if (!new RegExp(`\\b${nome}\\b`, 'i').test(texto)) continue;
    const atual = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia)).getUTCDay();
    const delta = (alvo - atual + 7) % 7;
    return somarDias(hoje, delta);
  }

  return null;
}

function somarDias(d: { ano: number; mes: number; dia: number }, n: number) {
  const base = new Date(Date.UTC(d.ano, d.mes - 1, d.dia));
  base.setUTCDate(base.getUTCDate() + n);
  return { ano: base.getUTCFullYear(), mes: base.getUTCMonth() + 1, dia: base.getUTCDate() };
}

function diasDeDiferenca(a: { ano: number; mes: number; dia: number }, b: { ano: number; mes: number; dia: number }): number {
  const ta = Date.UTC(a.ano, a.mes - 1, a.dia);
  const tb = Date.UTC(b.ano, b.mes - 1, b.dia);
  return Math.round((ta - tb) / 86_400_000);
}

/** Unidade/local citado no texto, quando houver ("em Ibiporã", "na unidade Centro"). */
function extrairUnidade(texto: string): string | undefined {
  const m = texto.match(/\b(?:em|na unidade|no endere[çc]o|unidade)\s+([A-ZÀ-Ý][\wÀ-ÿ'’-]*(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'’-]*)?)/);
  return m ? m[1].trim().replace(/[.,;:]$/, '') : undefined;
}

export function extrairDataHora(mensagens: string[], agora = new Date()): DataHora | null {
  const texto = mensagens.join('\n');
  const hora = extrairHora(texto);
  if (!hora) return null;
  const data = extrairData(texto, agora);
  if (!data) return null;
  return {
    iso: `${data.ano}-${pad(data.mes)}-${pad(data.dia)}T${pad(hora.hora)}:${pad(hora.minuto)}:00`,
    unidade: extrairUnidade(texto),
  };
}

// ── Já existe evento para esta conversa? ─────────────────────

export function criouEventoNesteTurno(tools: ToolCallLog[]): boolean {
  return tools.some((t) => SLUG_CRIACAO_RE.test(t.tool) && !resultadoFalhou(t.result));
}

function resultadoFalhou(result: unknown): boolean {
  if (result == null) return true;
  const obj = typeof result === 'string' ? tentarParse(result) : result;
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;

  // Envelope de `tools/envelope.ts`. Sem este ramo o guard leria `{status:'error'}`
  // como sucesso — não há `success:false` nem `error` no topo — e voltaria a achar
  // que o evento foi criado quando a intenção falhou. `empty` também conta como
  // falha aqui: criação que não devolveu nada não criou nada.
  if (typeof r.status === 'string' && 'query_echo' in r) {
    if (r.status === 'error' || r.status === 'empty') return true;
    // status 'ok': o payload real está em `data` — o veredito é sobre ele.
    return resultadoFalhou(r.data);
  }

  if (r.success === false) return true;
  if (typeof r.error === 'string' && r.error.trim() !== '') return true;
  return false;
}

function tentarParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/** Horários que a agenda ofereceu nesta conversa — usados na reoferta. */
export function slotsOferecidos(logs: IntentLog[]): string[] {
  const ultimo = [...logs].reverse().find((l) => SLUG_SLOTS_RE.test(l.intent_key) && l.success);
  if (!ultimo) return [];
  const data = ultimo.response_data as { available_slots?: Array<{
    day?: string; date?: string; slots?: string[];
    slots_por_unidade?: Array<{ horario: string; unidade: string }>;
  }> } | null;
  if (!data?.available_slots?.length) return [];

  const linhas: string[] = [];
  for (const dia of data.available_slots.slice(0, 2)) {
    const rotulo = dia.day && dia.date
      ? `${dia.day}, ${dia.date.slice(8, 10)}/${dia.date.slice(5, 7)}`
      : (dia.date ?? dia.day ?? '');
    const porUnidade = dia.slots_por_unidade ?? [];
    if (porUnidade.length) {
      for (const s of porUnidade.slice(0, 3)) linhas.push(`${rotulo} às ${s.horario} em ${s.unidade}`);
    } else {
      for (const h of (dia.slots ?? []).slice(0, 3)) linhas.push(`${rotulo} às ${h}`);
    }
  }
  return linhas.slice(0, 4);
}

// ── Reoferta: o que dizer quando a criação foi recusada ──────

export function mensagemDeReoferta(slots: string[]): string[] {
  if (!slots.length) {
    return [
      'Deixa eu conferir a agenda aqui rapidinho — esse horário acabou de sair da lista. 🙏',
      'Me diz qual dia e período ficam melhores pra você que eu já te trago as opções livres.',
    ];
  }
  return [
    'Deixa eu conferir a agenda aqui rapidinho — esse horário acabou de ser preenchido. 🙏',
    `Consigo estes:\n${slots.map((s) => `- ${s}`).join('\n')}\n\nQual fica melhor pra você?`,
  ];
}

// ── Orquestração do reparo ───────────────────────────────────

export interface ContextoReparo {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  contact_phone: string;
  intents: AgentIntent[];
  /** Já existe compromisso criado nesta conversa (query dedicada, sem janela). */
  jaTemCompromisso: boolean;
  /** Últimos logs — só para remontar os horários oferecidos na reoferta. */
  logsDaConversa: IntentLog[];
  toolsDoTurno: ToolCallLog[];
  mensagens: string[];
  agora?: Date;
  executarIntent?: ExecutarIntent;   // injetável no teste
}

export type ResultadoGuard =
  | { acao: 'nada' }                                        // caminho feliz ou fora de escopo
  | { acao: 'reparado'; slug: string; iso: string }          // evento criado sem o cliente perceber
  | { acao: 'detectado'; slug: string; iso: string | null }  // fantasma visto, reparo não suportado
  | { acao: 'reoferta'; mensagens: string[]; motivo: string }; // criação recusada, agente reoferece

export async function garantirAgendamento(ctx: ContextoReparo): Promise<ResultadoGuard> {
  try {
    if (!afirmaAgendamento(ctx.mensagens)) return { acao: 'nada' };

    const intentCriacao = ctx.intents.find((i) => SLUG_CRIACAO_RE.test(i.slug));
    if (!intentCriacao) return { acao: 'nada' };   // agente sem agenda: não é assunto deste guard

    if (criouEventoNesteTurno(ctx.toolsDoTurno)) return { acao: 'nada' };
    if (ctx.jaTemCompromisso) return { acao: 'nada' };

    // Agente cujo reparo automático não é suportado: só registra o fantasma.
    // Nada de rede, nada de reescrever a resposta — em `realizar_agendamento` o
    // guard não tem `nome`/`valor`/`especialidade` para montar a chamada.
    if (!SLUG_REPARAVEL_RE.test(intentCriacao.slug)) {
      const quandoDetectado = extrairDataHora(ctx.mensagens, ctx.agora ?? new Date());
      console.error(
        `[Guard] agendamento fantasma DETECTADO (reparo nao suportado para "${intentCriacao.slug}") — ` +
        `quando=${quandoDetectado?.iso ?? 'ilegivel'} lead=${ctx.lead_id}`,
      );
      return { acao: 'detectado', slug: intentCriacao.slug, iso: quandoDetectado?.iso ?? null };
    }

    const quando = extrairDataHora(ctx.mensagens, ctx.agora ?? new Date());
    if (!quando) {
      // Confirmação sem data/hora legível no turno. Quase sempre é o agente
      // remetendo a um agendamento que já existe ("sua consulta já ficou
      // marcada", "o que está confirmado é..."), e reescrever a resposta aí
      // atrapalharia uma conversa saudável. Sem quando, não há o que criar:
      // deixa passar e registra para auditoria.
      console.warn('[Guard] confirmação sem data/hora legível, seguindo:', ctx.mensagens.join(' | ').slice(0, 200));
      return { acao: 'nada' };
    }

    console.warn(`[Guard] agendamento fantasma detectado — criando ${quando.iso} via ${intentCriacao.slug} (lead ${ctx.lead_id})`);

    const args: Record<string, unknown> = { action: 'create_event', startDateTime: quando.iso };
    if (quando.unidade) args.location = quando.unidade;

    const executar = ctx.executarIntent ?? executarIntentPadrao;
    const bruto = await executar(
      { intent_key: intentCriacao.slug, arguments: args },
      { agent_id: ctx.agent_id, conversation_id: ctx.conversation_id }
    );

    if (resultadoFalhou(tentarParse(bruto))) {
      console.warn('[Guard] criação recusada:', bruto.slice(0, 300));
      return {
        acao: 'reoferta',
        mensagens: mensagemDeReoferta(slotsOferecidos(ctx.logsDaConversa)),
        motivo: 'criacao_recusada',
      };
    }

    console.log(`[Guard] evento criado — cliente segue com a confirmação original (lead ${ctx.lead_id})`);
    return { acao: 'reparado', slug: intentCriacao.slug, iso: quando.iso };
  } catch (err: unknown) {
    // Falha-aberto: guard quebrado nunca pode segurar a resposta do agente.
    console.error('[Guard] erro inesperado, resposta segue intacta:', err instanceof Error ? err.message : String(err));
    return { acao: 'nada' };
  }
}
