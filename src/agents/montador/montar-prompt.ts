// Montador único, passo 1: reproduz em código o que o nó `Prompt_Variavel` do AGENTE BASE (n8n) monta.
//
// Função PURA: recebe o que o n8n lê do banco (linhas já buscadas) e devolve o system prompt. Não
// consulta nada, não lê relógio nem variável de ambiente. Cada trecho abaixo espelha um nó do n8n e
// diz qual; a fidelidade é byte a byte, então nada aqui "melhora" o texto: onde o n8n tem uma
// esquisitice (array de palavras-chave unido por vírgula, estágios unidos por vírgula) ela é mantida.
//
// Ainda NÃO substitui o n8n: hoje só roda em sombra (`sombra.ts`), comparando com o `system_prompt`
// que o n8n manda no corpo do `/api/chat`.

import { ESTILO_RESPOSTA, TEXTO_FIXO, TRANSFERENCIA_DESLIGADA } from './texto-fixo';

// ── Entrada ───────────────────────────────────────────────────

/** Linha de `agent_trainings` (nó Ler_Treinamentos: id, name, content, injection_mode, metadata). */
export interface TreinamentoLinha {
  name?: string | null;
  content?: string | null;
  injection_mode?: string | null;
  metadata?: unknown;
}

/** Linha de `intent_execution_logs` (nó Buscar_Intents_Executadas), mais nova primeiro. */
export interface LogIntencaoLinha {
  intent_key?: string | null;
  success?: boolean | null;
  arguments?: unknown;
  created_at?: string | null;
}

/** Saída do nó Pack_Agent_Stages: estágio atual do lead e slugs disponíveis (sem `follow_up`). */
export interface EstagiosCrm {
  estagioAtual: string | null;
  estagiosDisponiveis: string[];
}

/** Linha de `messages` (nó Buscar_Inicio_Conversa: content, created_at). */
export interface MensagemInicioLinha {
  content?: string | null;
}

export interface EntradaMontador {
  /** `agents.prompt_config` (nó Encontrar_Agente). */
  promptConfig: Record<string, unknown> | null;
  /** `agent_trainings` ativos do agente, `created_at` crescente, até 100 (nó Ler_Treinamentos). */
  treinamentos: TreinamentoLinha[];
  /** Até 20 linhas, mais novas primeiro (nó Buscar_Intents_Executadas). */
  intencoesExecutadas: LogIntencaoLinha[];
  /** `null` = nó Pack_Agent_Stages não rodou: o n8n escreve vazio nos dois campos. */
  crm: EstagiosCrm | null;
  /** Até 4 mensagens inbound mais antigas da conversa (nó Buscar_Inicio_Conversa). */
  inicioConversa: MensagemInicioLinha[];
  /** Nome como o WhatsApp mandou (`contact_name` do webhook); a capitalização do n8n é feita aqui. */
  contatoNome: string | null;
  contatoTelefone: string;
  /** Instante do turno, para a linha "Horário". */
  agora: Date;
}

// ── Utilitários de "como o n8n escreve um valor dentro de {{ }}" ──────────────

/** null/undefined viram vazio; array vira `a,b,c` (Array.toString, como o n8n); objeto vira JSON. */
function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** `Variables` do Fluxo_Variaveis1 é `prompt_config.variables` serializado; as expressões fazem JSON.parse. */
function lerVariaveis(promptConfig: Record<string, unknown> | null): Record<string, unknown> {
  const v = promptConfig?.variables;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      // string que não é JSON: no n8n o JSON.parse estoura e o nó falha; aqui segue vazio
    }
  }
  return {};
}

// ── Montar_Conhecimento ───────────────────────────────────────

export const LIMITE_CONHECIMENTO = 30000;

export function montarConhecimento(treinamentos: TreinamentoLinha[]): string {
  let partes: string[] = [];
  try {
    for (const j of treinamentos) {
      if (String(j?.injection_mode || '') === 'ondemand') continue;

      const meta =
        j && typeof j.metadata === 'object' && j.metadata ? (j.metadata as Record<string, unknown>) : {};
      if (meta.is_chunk_sibling === true || String(meta.is_chunk_sibling || '') === 'true') continue;

      const texto = String(j?.content || '').trim();
      if (!texto) continue;
      const titulo = String(j?.name || '').trim();
      partes.push(titulo ? '## ' + titulo + String.fromCharCode(10) + texto : texto);
    }
  } catch {
    partes = [];
  }
  const conhecimento = partes.join(String.fromCharCode(10, 10));
  return conhecimento.length > LIMITE_CONHECIMENTO ? conhecimento.slice(0, LIMITE_CONHECIMENTO) : conhecimento;
}

// ── Formata_Intents ───────────────────────────────────────────

export function formatarIntencoes(logs: LogIntencaoLinha[]): string {
  return logs
    .filter((log) => log && log.intent_key)
    .map((log) => {
      const hora = new Date(log.created_at as string).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const status = log.success ? '✓' : '✗';
      // Inclui os argumentos: sem eles o agente sabe QUE executou, mas não COM O QUE.
      let args = '';
      try {
        const a = typeof log.arguments === 'string' ? JSON.parse(log.arguments) : log.arguments;
        if (a && typeof a === 'object') {
          args = Object.entries(a as Record<string, unknown>)
            .map(([k, v]) => k + '=' + String(v).slice(0, 120))
            .join(', ');
        }
      } catch {
        args = '';
      }
      return `[${hora}] ${status} ${log.intent_key}` + (args ? ` | ${args}` : '');
    })
    .join('\n');
}

// ── Pack_Inicio_Conversa ──────────────────────────────────────

export function formatarInicioConversa(mensagens: MensagemInicioLinha[]): string {
  const linhas: string[] = [];
  for (const it of mensagens) {
    const t = String((it && it.content) || '').trim();
    if (t) linhas.push('- ' + t.slice(0, 180));
    if (linhas.length >= 4) break;
  }
  return linhas.join(String.fromCharCode(10));
}

// ── Fluxo_Variaveis1: ClienteNome ─────────────────────────────

export function formatarNomeContato(nome: string | null | undefined): string {
  const name = nome || '';
  return name
    .split(' ')
    .filter((w) => w)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ── Horário: $now.setZone('America/Sao_Paulo').setLocale('pt-BR').toFormat('cccc, dd/MM/yyyy HH:mm') ──

const FORMATO_HORARIO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatarHorario(agora: Date): string {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_HORARIO.formatToParts(agora)) p[parte.type] = parte.value;
  return `${p.weekday}, ${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// ── Regras de transferência ───────────────────────────────────

function regrasDeTransferencia(promptConfig: Record<string, unknown> | null): string {
  const h = promptConfig?.handoff_rules as { enabled?: unknown; keywords?: unknown } | null | undefined;
  if (h?.enabled === false) return TRANSFERENCIA_DESLIGADA;
  return comoTexto(h?.keywords);
}

function estiloDeResposta(promptConfig: Record<string, unknown> | null): string {
  const estilo = String(promptConfig?.response_style || 'equilibrado');
  return Object.prototype.hasOwnProperty.call(ESTILO_RESPOSTA, estilo) ? ESTILO_RESPOSTA[estilo] : '';
}

// ── Montagem ──────────────────────────────────────────────────

export function montarPrompt(entrada: EntradaMontador): string {
  const pc = entrada.promptConfig;
  const vars = lerVariaveis(pc);

  const interpolacoes: string[] = [
    /* 0  */ montarConhecimento(entrada.treinamentos),
    /* 1  */ comoTexto(pc?.system_prompt),
    /* 2  */ comoTexto(vars.communication_tone),
    /* 3  */ estiloDeResposta(pc),
    /* 4  */ regrasDeTransferencia(pc),
    /* 5  */ formatarNomeContato(entrada.contatoNome),
    /* 6  */ entrada.contatoTelefone,
    /* 7  */ formatarHorario(entrada.agora),
    /* 8  */ comoTexto(vars.company_name),
    /* 9  */ comoTexto(vars.company_description),
    /* 10 */ entrada.crm ? comoTexto(entrada.crm.estagioAtual || '') : '',
    /* 11 */ entrada.crm ? comoTexto(entrada.crm.estagiosDisponiveis || '') : '',
    /* 12 */ formatarIntencoes(entrada.intencoesExecutadas),
    /* 13 */ formatarInicioConversa(entrada.inicioConversa),
  ];

  let prompt = '';
  for (let i = 0; i < interpolacoes.length; i++) prompt += TEXTO_FIXO[i] + interpolacoes[i];
  return prompt + TEXTO_FIXO[interpolacoes.length];
}
