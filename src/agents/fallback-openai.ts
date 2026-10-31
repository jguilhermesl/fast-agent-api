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
