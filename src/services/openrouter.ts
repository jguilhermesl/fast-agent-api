/**
 * OpenRouter: o mesmo contrato `chat.completions` da OpenAI para modelos de vários
 * fornecedores, com id `fornecedor/modelo` (`openai/gpt-6-luna`, `deepseek/deepseek-v4.1-flash`).
 *
 * Por que existe (31/10/2026): até aqui só o orquestrador falava com o OpenRouter, e
 * pela metade. O fallback mandava `gpt-5.4` (sem fornecedor) para o próprio OpenRouter,
 * o custo caía em `TARIFA_DESCONHECIDA`, o `openai/gpt-6-luna` recebia `temperature` (que
 * a família recusa) e o executor nem conhecia o provedor. Este módulo junta o que é
 * específico do OpenRouter num lugar só, em funções puras, para os dois caminhos usarem.
 *
 * Três coisas que todo pedido ao OpenRouter leva (`extrasOpenRouter`):
 *   - `provider.data_collection: 'deny'`: só fornecedores que não guardam nem treinam com o
 *     pedido. A conversa é de paciente (dado sensível na LGPD). Um modelo sem fornecedor que
 *     aceite isso devolve erro, o orquestrador cai no gpt-5.4 e o erro fica em
 *     `agent_error_logs`: melhor que mandar o dado para quem treina com ele.
 *   - `usage.include: true`: a resposta traz `usage.cost`, o valor cobrado em USD. É ele que
 *     vai para `llm_usage_logs.estimated_cost_usd`, sem depender de tabela de tarifa.
 *   - Cabeçalhos de identificação do app (`HTTP-Referer`, `X-Title`), pedidos pela documentação.
 */
import OpenAI from 'openai';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Id do OpenRouter tem fornecedor e modelo separados por barra; nenhum id direto da OpenAI ou da Anthropic tem. */
const ID_OPENROUTER = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/i;

export function ehModeloOpenRouter(modelo: string): boolean {
  return ID_OPENROUTER.test(modelo.trim());
}

/** `openai/gpt-6-luna` → `gpt-6-luna`. Usado para regra por família e tarifa de reserva. */
export function semFornecedor(modelo: string): string {
  const i = modelo.indexOf('/');
  return i >= 0 ? modelo.slice(i + 1) : modelo;
}

export function criarClienteOpenRouter(apiKey: string, timeout: number): OpenAI | null {
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    timeout,
    maxRetries: 1,
    defaultHeaders: { 'HTTP-Referer': 'https://agents.fast-ia.com', 'X-Title': 'Fast IA Agents' },
  });
}

/** Campos que só o OpenRouter entende. Vão em toda chamada para ele (ver o topo do arquivo). */
export function extrasOpenRouter(): { provider: { data_collection: 'deny' }; usage: { include: true } } {
  return { provider: { data_collection: 'deny' }, usage: { include: true } };
}

/** `usage.cost` do OpenRouter, em USD. Ausente ou inválido = `undefined` (aí o custo sai da tarifa). */
export function custoDoOpenRouter(usage: unknown): number | undefined {
  const custo = (usage as { cost?: unknown } | null | undefined)?.cost;
  return typeof custo === 'number' && Number.isFinite(custo) && custo >= 0 ? custo : undefined;
}

/**
 * Soma o custo das rodadas de um turno. Uma rodada sem `usage.cost` invalida a soma
 * (`null`): custo parcial gravado como total é pior que a estimativa pela tarifa.
 */
export function somarCusto(acumulado: number | null, custo: number | undefined): number | null {
  if (acumulado === null || custo === undefined) return null;
  return acumulado + custo;
}

/**
 * Modelo da Anthropic pelo OpenRouter só usa cache de prompt com `cache_control`
 * explícito no conteúdo (OpenAI e os demais cacheiam sozinhos). Marca o system, que é
 * a persona fixa e a maior parte dos tokens. Os outros modelos recebem as mensagens como estão.
 */
export function mensagensParaOpenRouter(
  modelo: string,
  mensagens: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (!modelo.startsWith('anthropic/')) return mensagens;
  return mensagens.map((m) => {
    if (m.role !== 'system' || typeof m.content !== 'string') return m;
    const parte = { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } };
    return { role: 'system', content: [parte as OpenAI.Chat.ChatCompletionContentPartText] };
  });
}
