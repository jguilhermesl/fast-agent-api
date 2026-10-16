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

import type { ChatMessage, ToolCallLog } from '../types';

// ── 1. Grounding por token literal ───────────────────────────

const RE_DINHEIRO = /R\$\s?\d[\d.\s]*(?:,\d{2})?/g;
const RE_HORA = /\b([01]?\d|2[0-3])\s?(?:h|:)\s?([0-5]\d)?\b/g;
const RE_DATA = /\b([0-3]?\d)\/([01]?\d)(?:\/\d{2,4})?\b/g;

function norm(s: string): string {
  return s.replace(/\D/g, '');
}

const pad2 = (s: string) => s.padStart(2, '0');

/**
 * Converte qualquer grafia de dinheiro para **centavos**, que é a única forma em
 * que "R$ 160" e "R$ 160,00" são o mesmo número.
 *
 *   "R$ 160"      -> "16000"
 *   "R$ 160,00"   -> "16000"
 *   "R$ 1.750,00" -> "175000"
 *   "R$ 1.750"    -> "175000"
 */
function dinheiroEmCentavos(bruto: string): string | null {
  const limpo = bruto.replace(/R\$/g, '').replace(/\s/g, '');
  const [inteiroBruto, centavosBruto] = limpo.split(',');
  const inteiro = inteiroBruto.replace(/\./g, '');
  if (!inteiro) return null;
  const centavos = (centavosBruto ?? '00').padEnd(2, '0').slice(0, 2);
  return inteiro + centavos;
}

/**
 * Cada tipo vira uma forma canônica, senão o mesmo número escrito de dois jeitos
 * conta como token diferente e vira falso positivo. Medido em 01-02/09/2026
 * contra tráfego real, foi de onde vieram TODOS os falsos positivos:
 *
 *  - **hora sempre HHMM.** "às 15h" dava "15" e "15:00" dava "1500" — o mesmo
 *    horário não casava consigo mesmo. Agora os dois dão "1500".
 *  - **data só DDMM.** "01/09/2026" dava "01092026" e "01/09" dava "0109";
 *    o agente escreve uma forma e a planilha devolve a outra.
 *  - **dinheiro sempre em centavos.** Mesmo bug, descoberto em 21/09/2026: o
 *    `system_prompt` da Duda diz "R$ 24 na LP Saúde mais R$ 136 na parceira,
 *    total R$ 160" e a resposta sai "R$ 24,00 / R$ 136,00 / R$ 160,00". Sem
 *    centavos dava "24"/"136"/"160", com centavos dava "2400"/"13600"/"16000",
 *    e o valor que estava escrito na própria persona era marcado como sem
 *    lastro. Foram os 9 únicos `ungrounded_sem_ferramenta` de 30 dias — todos
 *    falso positivo, e todos no único caso em que o guard bloqueia de verdade.
 *  - **mínimo de 3 dígitos.** Token de 2 dígitos é ruído: "22" e "08" soltos
 *    marcaram 2 turnos da Carol como sem lastro sem nada de errado na mensagem.
 *    Com a hora virando 4 dígitos, nada de sinal se perde nessa faixa.
 */
function extrairTokens(texto: string): string[] {
  const out = new Set<string>();

  // As DUAS formas entram, a canônica em centavos e a crua. A canônica é a que
  // faz "R$ 160" casar com "R$ 160,00"; a crua é a rede para quando o valor
  // aparece no corpus sem o "R$" (numa célula de planilha, por exemplo) e só a
  // sopa de dígitos o alcança. Gerar as duas erra para o lado permissivo, que é
  // o lado certo aqui: falso positivo trava conversa de cliente real.
  RE_DINHEIRO.lastIndex = 0;
  for (const m of texto.matchAll(RE_DINHEIRO)) {
    for (const n of [dinheiroEmCentavos(m[0]), norm(m[0])]) {
      if (n && n.length >= 3 && n.length <= 8) out.add(n);
    }
  }

  RE_HORA.lastIndex = 0;
  for (const m of texto.matchAll(RE_HORA)) {
    out.add(pad2(m[1]) + pad2(m[2] ?? '00'));
  }

  RE_DATA.lastIndex = 0;
  for (const m of texto.matchAll(RE_DATA)) {
    out.add(pad2(m[1]) + pad2(m[2]));
  }

  return [...out];
}

export interface GuardVerdict {
  verdict: 'ok' | 'ungrounded';
  tokens_sem_lastro: string[];
  corpus_bytes: number;
}

/**
 * O corpus de grounding é largo, mas NÃO pode incluir tudo:
 *  - toolResults   : o caso legítimo (veio da planilha/agenda)
 *  - clientMessage : o agente ecoando o que o cliente propôs
 *  - history       : ver `historicoConfiavel` abaixo — é a parte perigosa
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
  const texto = [input.toolResults, input.clientMessage, input.history, input.systemPrompt].join(' ');

  // O corpus passa pela MESMA canonicalização das mensagens — senão "às 15h" na
  // fala do cliente nunca casaria com "15:00" na agenda. Além dos tokens
  // canônicos, guarda-se a sopa de dígitos crua: pega número escrito em formato
  // que as três regex não cobrem, e erra para o lado permissivo (que é o certo
  // aqui — falso positivo trava conversa de cliente real).
  const canonicos = new Set(extrairTokens(texto));
  const sopa = norm(texto);

  const semLastro = extrairTokens(input.mensagens.join(' ')).filter(
    (t) => !canonicos.has(t) && !sopa.includes(t),
  );

  return {
    verdict: semLastro.length > 0 ? 'ungrounded' : 'ok',
    tokens_sem_lastro: semLastro,
    corpus_bytes: sopa.length,
  };
}

// ── 1b. Valor e data sem fonte, para BLOQUEAR (não só registrar) ─────────
//
// 13/10/2026 (Duda, lead 18ac4f90): a busca devolveu o preventivo a R$ 150 com
// Raiany 15/10, Amanda 19/10, Sandrele 24/10 e Aline 27/10; a resposta saiu
// "R$ 100,00, Aline Cordeiro sexta 16/10 e 23/10". `checarGrounding` marcou os
// três tokens (10000, 1610, 2310) e nada aconteceu: o bloqueio só valia sem
// ferramenta no turno, e o modo era shadow. Medido em 30 dias: 23 alertas, ao
// menos 6 preços inventados (preventivo R$ 100, neuropediatria R$ 250, sexagem
// R$ 100, endoscopia R$ 250/280 duas vezes); o resto, soma ou parcela de valores
// certos, horário de coleta e valor repetido de turno anterior.
//
// Daqui sai só o que vale bloquear: dinheiro e data (horário fica de fora, era
// a maior fonte de falso positivo), menos o dinheiro que é soma ou parcela de
// valores que têm fonte (o "Total: R$ 68,50" de quatro exames certos).

export interface ValorSemFonte {
  tipo: 'dinheiro' | 'data';
  /** Como saiu na resposta, para citar na instrução de reescrita. */
  texto: string;
  canonico: string;
}

const MAX_PARCELAS = 12;
const MAX_POOL_SOMA = 14;

/** Algum subconjunto (2 ou mais) de `pool` soma `alvo`? Tolerância de 1 centavo. */
function ehSomaDe(alvo: number, pool: number[]): boolean {
  // Sem deduplicar: "hemograma R$ 15 + creatinina R$ 15" precisa dos dois 15.
  const p = pool.filter((v) => v > 0 && v < alvo).slice(0, MAX_POOL_SOMA);
  const n = p.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    if ((mask & (mask - 1)) === 0) continue; // um elemento só não é soma
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += p[i];
    if (Math.abs(s - alvo) <= 1) return true;
  }
  return false;
}

/** `alvo` é parcela (valor / n, 2 ≤ n ≤ 12) de algum valor do pool? */
function ehParcelaDe(alvo: number, pool: number[]): boolean {
  return pool.some((v) => {
    for (let n = 2; n <= MAX_PARCELAS; n++) if (Math.abs(v / n - alvo) <= 1) return true;
    return false;
  });
}

function centavosDoTexto(texto: string): number[] {
  RE_DINHEIRO.lastIndex = 0;
  return [...texto.matchAll(RE_DINHEIRO)]
    .map((m) => dinheiroEmCentavos(m[0]))
    .filter((c): c is string => !!c)
    .map(Number);
}

export function checarValoresSemFonte(input: {
  mensagens: string[];
  toolResults: string;
  clientMessage: string;
  history: string;
  systemPrompt: string;
}): ValorSemFonte[] {
  const corpus = [input.toolResults, input.clientMessage, input.history, input.systemPrompt].join(' ');
  const canonicos = new Set(extrairTokens(corpus));
  const sopa = norm(corpus);
  const temFonte = (t: string) => canonicos.has(t) || sopa.includes(t);
  const resposta = input.mensagens.join('\n');

  const valores: Array<{ texto: string; centavos: number; canonico: string; ok: boolean }> = [];
  RE_DINHEIRO.lastIndex = 0;
  for (const m of resposta.matchAll(RE_DINHEIRO)) {
    const c = dinheiroEmCentavos(m[0]);
    if (!c || c.length < 3 || c.length > 8) continue;
    valores.push({ texto: m[0].trim(), centavos: Number(c), canonico: c, ok: temFonte(c) });
  }

  // Soma e parcela: de valores com fonte na resposta e do histórico confiável
  // ("pelos valores que te passei, o total fica R$ 470"). Repete até estabilizar,
  // porque "total com o pacote" pode ser soma de um subtotal que também é soma.
  const doHistorico = centavosDoTexto(input.history).slice(-MAX_POOL_SOMA);
  let mudou = true;
  while (mudou) {
    mudou = false;
    const pool = [...valores.filter((v) => v.ok).map((v) => v.centavos), ...doHistorico];
    for (const v of valores) {
      if (!v.ok && (ehSomaDe(v.centavos, pool) || ehParcelaDe(v.centavos, pool))) {
        v.ok = true;
        mudou = true;
      }
    }
  }

  const out: ValorSemFonte[] = [];
  const vistos = new Set<string>();
  for (const v of valores) {
    if (v.ok || vistos.has(v.canonico)) continue;
    vistos.add(v.canonico);
    out.push({ tipo: 'dinheiro', texto: v.texto, canonico: v.canonico });
  }

  RE_DATA.lastIndex = 0;
  for (const m of resposta.matchAll(RE_DATA)) {
    const dia = Number(m[1]), mes = Number(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    const canonico = pad2(m[1]) + pad2(m[2]);
    if (temFonte(canonico) || vistos.has(canonico)) continue;
    vistos.add(canonico);
    out.push({ tipo: 'data', texto: m[0], canonico });
  }
  return out;
}

/**
 * Monta a parte do corpus que vem do histórico — e é aqui que a primeira versão
 * do guard morria.
 *
 * Testado contra o incidente real (lead 50404509, 31/08/2026): com o histórico
 * inteiro no corpus, o guard dava `ok` em TODOS os turnos, inclusive nos que
 * inventaram "R$ 100,00" e "01/09 às 15h". O motivo: no turno 2 o corpus já
 * continha a fala do turno 1 — ou seja, **a alucinação servia de lastro para si
 * mesma**. É exatamente o mecanismo do incidente (o Orquestrador lê o próprio
 * texto no histórico e o trata como fato), então incluí-lo cega o guard no único
 * caso que ele existe para pegar.
 *
 * Entra no corpus:
 *  - toda fala do CLIENTE (ele é fonte legítima do que ele mesmo propôs);
 *  - fala do agente APENAS quando aquele turno rodou ferramenta de negócio, isto
 *    é, quando o número que ele disse veio de uma consulta de verdade.
 *
 * Fica de fora a fala do agente em turno sem ferramenta — que é, por definição,
 * número que ele não foi buscar em lugar nenhum.
 */
export function historicoConfiavel(history: ChatMessage[]): string {
  return history
    .filter((m) => {
      if (m.role === 'user') return true;
      const tools = m.tools ?? [];
      return tools.some((t) => !FERRAMENTAS_NAO_DE_NEGOCIO.has(t));
    })
    .map((m) => m.content)
    .join('\n');
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
