// Envelope único de retorno de ferramenta.
//
// Antes disto, `handlers.ts` devolvia `JSON.stringify(response.data)` cru: `[]`,
// `{}` e `{"available_slots":[]}` chegavam ao modelo IDÊNTICOS a um resultado
// cheio, e um HTTP 400 virava a string genérica "Request failed with status code
// 400" — sem status, sem corpo, sem o motivo. O modelo então preenchia o vazio.
//
// `isEmptyPayload` é a tradução 1:1 de public.diag_is_empty_response
// (migration 20260803233000_diag_functions.sql). Se um dos dois mudar, o outro
// TEM que mudar junto — senão o painel e o agente discordam sobre o que é vazio.

export type ToolStatus = 'ok' | 'empty' | 'error';

export interface ToolEnvelope {
  status: ToolStatus;
  http_status: number | null;
  data: unknown;
  query_echo: Record<string, unknown>;
  hint?: string;
}

export function isEmptyPayload(data: unknown): boolean {
  if (data === null || data === undefined) return true;

  if (typeof data === 'string') {
    const t = data.trim();
    return t === '' || t === 'null' || t === '[]' || t === '{}';
  }

  if (Array.isArray(data)) return data.length === 0;

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return true; // {}
    // Espelha `exists (select 1 from jsonb_each(p_data) e where e.value = '[]')`:
    // QUALQUER chave com array vazio marca o envelope inteiro como vazio.
    // Consequência conhecida e intencional: {"available_slots":[],"message":"x"}
    // conta como vazio. É o mesmo critério do painel.
    if (entries.some(([, v]) => Array.isArray(v) && v.length === 0)) return true;
  }

  return false;
}

const HINT_EMPTY =
  'A busca não retornou nenhum resultado. NÃO afirme que o item não existe: ' +
  'o termo pode estar errado. Tente UMA vez com um termo mais curto (1-2 palavras). ' +
  'Se continuar vazio, reporte "BUSCA_VAZIA: <termo>" e não invente.';

const HINT_ERROR =
  'A ferramenta FALHOU. Nenhuma ação foi executada. NÃO confirme nada ao cliente. ' +
  'Reporte a falha literal ao Orquestrador.';

export function wrap(
  data: unknown,
  queryEcho: Record<string, unknown>,
  httpStatus: number | null = null,
): string {
  const env: ToolEnvelope = isEmptyPayload(data)
    ? { status: 'empty', http_status: httpStatus, data, query_echo: queryEcho, hint: HINT_EMPTY }
    : { status: 'ok', http_status: httpStatus, data, query_echo: queryEcho };
  return JSON.stringify(env);
}

export function wrapError(err: unknown, queryEcho: Record<string, unknown>): string {
  const anyErr = err as {
    response?: { status?: number; data?: unknown };
    message?: string;
    code?: string;
  };
  const env: ToolEnvelope = {
    status: 'error',
    http_status: anyErr?.response?.status ?? null,
    // O corpo real do 4xx/5xx — é ele que diz POR QUE falhou. Antes era descartado.
    data:
      anyErr?.response?.data ??
      { message: anyErr?.message ?? String(err), code: anyErr?.code ?? null },
    query_echo: queryEcho,
    hint: HINT_ERROR,
  };
  return JSON.stringify(env);
}
