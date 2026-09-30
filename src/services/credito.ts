import { DeadlineExceededError } from './deadline';

/**
 * Reconhece "o crédito do provedor acabou" — e SÓ isso.
 *
 * Por que existe: em 02/09/2026 e de novo em 29/09/2026 (16:46–16:49 BRT) o crédito
 * da OpenAI zerou e TODO agente `openai` passou a responder "Só um momento, por
 * favor." + transferir para humano. A falha é rápida (~1 s) e volta 200 para o
 * n8n, então passa despercebida. Com um segundo provedor configurado, dá para
 * responder o cliente em vez de transferir — mas só vale trocar de provedor
 * quando o problema é CRÉDITO. Os outros erros têm outra causa e outro conserto:
 *
 *   - 429 `rate_limit_exceeded` (limite por minuto): passa sozinho em segundos; o
 *     SDK já tenta de novo. Trocar de provedor aqui mudaria o modelo da conversa
 *     por um soluço de tráfego.
 *   - 5xx / timeout / rede: instabilidade, não conta zerada.
 *   - `DeadlineExceededError`: o turno já estourou o orçamento de tempo; tentar
 *     outro provedor gastaria o tempo que não sobra (ver services/deadline.ts).
 *
 * Formatos reais que motivaram cada regra:
 *   OpenAI (agent_error_logs, 02/09 e 29/09):
 *     status 429, type `insufficient_quota`, code `credit_balance_exhausted`,
 *     message "429 You have no credits remaining. Add credits to continue ..."
 *   OpenAI (conta sem saldo, formato antigo da doc):
 *     status 429, code `insufficient_quota`, "You exceeded your current quota ..."
 *   Anthropic (doc de erros): status 400 `invalid_request_error`,
 *     "Your credit balance is too low to access the Anthropic API ..."
 *
 * Função pura, sem SDK: casa pelo FORMATO do erro (status/code/type/mensagem), não
 * por `instanceof` de classe do SDK — assim sobrevive a troca de versão do SDK e o
 * teste roda sem rede.
 */

const CODIGOS_DE_CREDITO = new Set(['insufficient_quota', 'credit_balance_exhausted']);

const MENSAGENS_DE_CREDITO = [
  /no credits remaining/i,
  /you have no credits/i,
  /insufficient_quota/i,
  /credit_balance_exhausted/i,
  /exceeded your current quota/i,
  /credit balance is too low/i,
];

type ErroComCampos = Error & {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  error?: { code?: unknown; type?: unknown; error?: { type?: unknown } } | null;
};

export function ehErroDeCredito(err: unknown): boolean {
  // Não-Error (string, objeto solto, undefined) nunca vem do SDK: não arrisca.
  if (!(err instanceof Error)) return false;
  if (err instanceof DeadlineExceededError) return false;

  const e = err as ErroComCampos;
  const codigos = [e.code, e.type, e.error?.code, e.error?.type, e.error?.error?.type];
  if (codigos.some((c) => typeof c === 'string' && CODIGOS_DE_CREDITO.has(c))) return true;

  return MENSAGENS_DE_CREDITO.some((re) => re.test(e.message));
}

/**
 * Decide se o turno deve ser refeito no provedor reserva (Anthropic).
 *
 * Só agentes `openai`: o caminho inverso (agente `anthropic` falhou → OpenAI
 * `gpt-4.1-mini`) já existe no orquestrador e não é mexido aqui.
 * `habilitado` vem de `FALLBACK_CREDITO` (env): desligar em produção tem que levar
 * segundos, sem redeploy — mesmo motivo do `GUARD_MODE`.
 */
export function deveUsarReserva(params: {
  provider: string;
  err: unknown;
  habilitado: boolean;
  temChave: boolean;
}): boolean {
  return (
    params.provider === 'openai' &&
    params.habilitado &&
    params.temChave &&
    ehErroDeCredito(params.err)
  );
}
