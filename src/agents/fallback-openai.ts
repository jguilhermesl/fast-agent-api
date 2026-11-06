/**
 * Pedido que o orquestrador refaz quando o provedor principal (Anthropic ou OpenRouter) falha.
 *
 * Até 31/10/2026 o fallback trocava só o modelo (`{ ...req, model_name: 'gpt-5.4' }`) e
 * mantinha `model_provider`. Com `openrouter`, o `runOpenAI` escolhia o cliente pelo
 * provedor e mandava `gpt-5.4` (sem fornecedor) para o próprio OpenRouter: o fallback
 * falhava de novo e o paciente recebia "Só um momento". Aqui o provedor vira `openai`
 * junto com o modelo, e a função é pura para ter teste.
 */
export const MODELO_FALLBACK_OPENAI = 'gpt-5.4';

export function pedidoDoFallback<T extends { model_provider: string; model_name: string }>(req: T): T {
  return { ...req, model_provider: 'openai', model_name: MODELO_FALLBACK_OPENAI };
}

/** Id do mesmo Claude no OpenRouter (`claude-sonnet-5-5` → `anthropic/claude-sonnet-5.5`). */
export function claudeNoOpenRouter(modelo: string): string | null {
  if (!/^claude-/.test(modelo)) return null;
  return `anthropic/${modelo.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

/**
 * Reserva do orquestrador. Regra do dono (03/11/2026): a Duda não gasta OpenAI. Em 28–30/10
 * o crédito da Anthropic acabou e 166 conversas foram para o gpt-5.4. Com chave do OpenRouter,
 * Anthropic cai no MESMO Claude pelo OpenRouter (saldo separado, mesma qualidade). Sem a chave,
 * ou com outro provedor principal, segue o fallback antigo.
 */
export function pedidoDaReserva<T extends { model_provider: string; model_name: string }>(req: T, temOpenRouter: boolean): T {
  if (req.model_provider === 'anthropic' && temOpenRouter) {
    const modelo = claudeNoOpenRouter(req.model_name);
    if (modelo) return { ...req, model_provider: 'openrouter', model_name: modelo };
  }
  return pedidoDoFallback(req);
}

/** Modelo e provedor de uma chamada extra (reescrita) feita com o provedor que respondeu o turno. */
export function modeloDaChamada(
  req: { model_provider: string; model_name: string },
  provider: string,
  temOpenRouter: boolean,
): { modelo: string; provedor: string } {
  if (provider === req.model_provider) return { modelo: req.model_name, provedor: provider };
  const reserva = pedidoDaReserva(req, temOpenRouter);
  if (provider === reserva.model_provider) return { modelo: reserva.model_name, provedor: provider };
  return { modelo: MODELO_FALLBACK_OPENAI, provedor: 'openai' };
}

/**
 * O executor que falhou no OpenRouter pode descer para o padrão (gpt-5.4-mini, OpenAI)?
 * Não quando ele já era a reserva de um Claude: a Duda não gasta OpenAI (regra do dono,
 * 04/11/2026; achado do Codex em 06/11: Anthropic → OpenRouter → OpenAI ainda acontecia).
 */
export function podeDescerParaOpenAI(reservaClaude: string | null, modeloDaVez: string): boolean {
  return !(reservaClaude && modeloDaVez === reservaClaude);
}
