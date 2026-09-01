// Guard de grounding.
//
// Existe porque em 31/08/2026 a Duda confirmou uma consulta com "Dr. João Silva"
// às 15h — médico que não existe, horário que não existe. A cadeia foi: o
// Orquestrador pediu ao Executor uma tarefa VENDA ("consultar valor e agenda de
// Clínico Geral"); o Executor chamou só `atualizar_lead_crm` e devolveu um
// retorno que não falava de agenda nenhuma; o Orquestrador preencheu o vazio.
// Medido em 10 dias de tráfego real: 130 de 2.402 turnos da Duda (5,4%) pediram
// tarefa de negócio e não tiveram NENHUMA ferramenta de negócio chamada.
//
// Duas verificações independentes, ambas determinísticas — nada de LLM:
//   1. `checarGrounding`  — todo token verificável (dinheiro, hora, data) que a
//      resposta afirma precisa aparecer em alguma fonte legítima.
//   2. `checarTarefaSemFerramenta` — tarefa de negócio pedida ao Executor sem
//      nenhuma ferramenta de negócio executada no turno.
//
// Critério estreito de propósito: falso positivo aqui trava conversa de cliente
// real. Por isso o padrão é shadow (`config.guardMode`).

import type { ToolCallLog } from '../types';

// ── 1. Grounding por token literal ───────────────────────────

const RE_DINHEIRO = /R\$\s?\d[\d.\s]*(?:,\d{2})?/g;
const RE_HORA = /\b([01]?\d|2[0-3])\s?(?:h|:)\s?([0-5]\d)?\b/g;
const RE_DATA = /\b([0-3]?\d)\/([01]?\d)(?:\/\d{2,4})?\b/g;

/** "R$ 1.500,00" -> "150000" ; "09h" -> "09" ; "11/08" -> "1108" */
function norm(s: string): string {
  return s.replace(/\D/g, '');
}

function extrairTokens(texto: string): string[] {
  const out = new Set<string>();
  for (const re of [RE_DINHEIRO, RE_HORA, RE_DATA]) {
    // `matchAll` exige a flag /g e consome o lastIndex — reinicia por segurança.
    re.lastIndex = 0;
    for (const m of texto.matchAll(re)) {
      const n = norm(m[0]);
      // <2 dígitos é ruído ("às 9"); >8 é CPF/telefone, não afirmação de agenda.
      if (n.length >= 2 && n.length <= 8) out.add(n);
    }
  }
  return [...out];
}

export interface GuardVerdict {
  verdict: 'ok' | 'ungrounded';
  tokens_sem_lastro: string[];
  corpus_bytes: number;
}

/**
 * O corpus de grounding é DELIBERADAMENTE largo. Cada fonte aqui elimina uma
 * classe inteira de falso positivo:
 *  - toolResults   : o caso legítimo (veio da planilha/agenda)
 *  - clientMessage : o agente ecoando o que o cliente propôs
 *  - history       : valor combinado três turnos atrás
 *  - systemPrompt  : preço que mora na persona (a KB da Duda foi migrada para o
 *                    prompt em 11/08 — sem isto, falso positivo em massa)
 */
export function checarGrounding(input: {
  mensagens: string[];
  toolResults: string;
  clientMessage: string;
  history: string;
  systemPrompt: string;
}): GuardVerdict {
  const corpus = norm(
    [input.toolResults, input.clientMessage, input.history, input.systemPrompt].join(' '),
  );
  const semLastro = extrairTokens(input.mensagens.join(' ')).filter((t) => !corpus.includes(t));

  return {
    verdict: semLastro.length > 0 ? 'ungrounded' : 'ok',
    tokens_sem_lastro: semLastro,
    corpus_bytes: corpus.length,
  };
}

// ── 2. Tarefa de negócio sem ferramenta ──────────────────────

/** Tipos de tarefa que só se resolvem consultando ou escrevendo em algum lugar. */
const TIPOS_DE_NEGOCIO = new Set([
  'VENDA',
  'AGENDAMENTO',
  'CONSULTA',
  'ACAO',
  'AÇÃO',
  'CONVERSAO',
  'CONVERSÃO',
  'ARQUIVO',
]);

/** Ferramentas que NÃO contam como "foi buscar o dado". */
const FERRAMENTAS_NAO_DE_NEGOCIO = new Set(['atualizar_lead_crm']);

export interface TarefaVerdict {
  verdict: 'ok' | 'tarefa_sem_ferramenta';
  tipos_pedidos: string[];
  tools_chamadas: string[];
}

/**
 * `query` é o array de tarefas que o Orquestrador serializou para o Executor
 * (orchestrator.ts: `JSON.stringify(args.tasks ?? [])`). Se ele pediu tarefa de
 * negócio e o turno não chamou nenhuma ferramenta de negócio, o texto que o
 * modelo produziu não tem de onde ter vindo.
 */
export function checarTarefaSemFerramenta(
  query: string | undefined,
  toolsDoTurno: ToolCallLog[],
): TarefaVerdict {
  const tools = toolsDoTurno.map((t) => t.tool);
  const semTarefa: TarefaVerdict = { verdict: 'ok', tipos_pedidos: [], tools_chamadas: tools };
  if (!query) return semTarefa;

  let tarefas: unknown;
  try {
    tarefas = JSON.parse(query);
  } catch {
    return semTarefa;
  }
  if (!Array.isArray(tarefas)) return semTarefa;

  const tipos = tarefas
    .map((t) => (t && typeof t === 'object' ? String((t as Record<string, unknown>).tipo ?? '') : ''))
    .filter((t) => TIPOS_DE_NEGOCIO.has(t.toUpperCase()));

  if (tipos.length === 0) return semTarefa;

  const houveFerramentaDeNegocio = tools.some((t) => !FERRAMENTAS_NAO_DE_NEGOCIO.has(t));
  return {
    verdict: houveFerramentaDeNegocio ? 'ok' : 'tarefa_sem_ferramenta',
    tipos_pedidos: tipos,
    tools_chamadas: tools,
  };
}

// ── 3. Texto de contenção ────────────────────────────────────
// Transferir é o PIOR desfecho, não o primeiro: aqui a resposta vira um pedido
// honesto de tempo, sem afirmar nada, e a conversa continua com o agente.

export const MENSAGEM_SEM_LASTRO = [
  'Deixa eu confirmar isso certinho na agenda e já te retorno com os valores e horários reais. 🙏',
];
