/**
 * Orçamento único de tempo por turno.
 *
 * `LLM_TIMEOUT_MS` (orchestrator.ts, executor.ts) só limita CADA chamada de LLM
 * isolada. O aninhamento orquestrador (MAX_TOOL_ROUNDS=5) × executor
 * (MAX_TOOL_ROUNDS=8) × timeout de tool HTTP (até 120s em tools/handlers.ts) não
 * tinha teto AGREGADO — o pior caso somava dezenas de minutos, com um cliente do
 * WhatsApp esperando do outro lado. Este módulo cria 1 relógio na entrada do
 * request (runOrchestrator) e cada camada abaixo — executor, handlers — consulta
 * o tempo restante antes de gastar mais uma rodada ou chamada de rede.
 *
 * Mora fora de orchestrator.ts/executor.ts de propósito, igual pricing.ts: é
 * aritmética pura sobre `Date.now()`, sem env var nem cliente de rede, então
 * testa sem subir nada.
 *
 * Default de 90s: bem acima do p95 medido (~15s, ver comentário de
 * LLM_TIMEOUT_MS em orchestrator.ts) — folga generosa pra um turno com busca de
 * KB + intent + múltiplas rodadas —, mas curto o bastante pra nunca chegar nos
 * "dezenas de minutos" do pior caso antigo. Configurável por `TURN_BUDGET_MS`
 * pra ajustar sem redeploy de código, caso o tráfego real peça outro número.
 */
export const TURN_BUDGET_MS = Number(process.env.TURN_BUDGET_MS ?? 90_000);

export interface Deadline {
  /** ms restantes até estourar o orçamento. Pode devolver negativo depois de estourado. */
  remaining(): number;
  /** O orçamento já estourou? */
  expired(): boolean;
}

export function createDeadline(budgetMs: number = TURN_BUDGET_MS): Deadline {
  const endsAt = Date.now() + budgetMs;
  return {
    remaining: () => endsAt - Date.now(),
    expired: () => Date.now() >= endsAt,
  };
}

/**
 * Erro específico de estouro de orçamento.
 *
 * Separado de erro genérico de provider pra o orquestrador NUNCA tentar o
 * fallback OpenAI quando o motivo de ter falhado foi falta de tempo — tentar de
 * novo só empilharia mais uma chamada de rede em cima de um orçamento que já
 * acabou, o oposto do que este módulo existe pra evitar.
 */
export class DeadlineExceededError extends Error {
  constructor(where: string) {
    super(`Orçamento de tempo do turno esgotado em: ${where}`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Limita um timeout de chamada de rede ao que resta do orçamento do turno.
 *
 * Nunca devolve menos que 1s — timeout=0 (ou negativo) trava algumas libs HTTP
 * em vez de abortar na hora — nem mais que o teto original da chamada. Sem
 * `deadline` (chamador fora do caminho do request, ex.: script solto), devolve
 * o teto original sem mudar nada.
 */
export function capTimeout(baseMs: number, deadline?: Deadline): number {
  if (!deadline) return baseMs;
  return Math.max(1_000, Math.min(baseMs, deadline.remaining()));
}
