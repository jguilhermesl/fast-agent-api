/**
 * Parâmetros de amostragem que variam por família de modelo.
 *
 * A família **gpt-5.6** (`terra`, `sol`, `luna`) recusa duas coisas que todo o
 * resto da plataforma manda desde sempre, e as duas devolvem HTTP 400:
 *
 *   temperature: 0.2
 *     -> "Unsupported value: 'temperature' does not support 0.2 with this model.
 *         Only the default (1) value is supported."
 *
 *   tools + reasoning_effort padrão
 *     -> "Function tools with reasoning_effort are not supported for gpt-5.6-terra
 *         in /v1/chat/completions. To use function tools, use /v1/responses or set
 *         reasoning_effort to 'none'."
 *
 * Medido em 22/09/2026 contra a API real. `'low'` também é recusado; dos valores
 * aceitos (`none`, `low`, `medium`, `high`, `xhigh`) só `'none'` convive com
 * function tools neste endpoint.
 *
 * Isso importa porque o `catch` do orquestrador transforma qualquer erro da
 * OpenAI em fallback de segurança: com `model_provider='openai'` não há segundo
 * provedor, então **toda** conversa do agente vira transferência para humano sem
 * gravar um token sequer. Foi assim que o Leandro passou um dia inteiro fora do
 * ar em 24/08/2026, com um `model_name` que a API não aceitava.
 *
 * Quem quiser gpt-5.6 COM raciocínio precisa migrar a chamada para
 * `/v1/responses`, que é outro contrato de request e de parsing de tool call.
 *
 * **gpt-6-luna** se comporta igual (medido em 16/10/2026: `temperature` + tools
 * dá o mesmo 400; `reasoning_effort: 'none'` + tools responde e chama a tool).
 * **gpt-6.1-terra** também (medido em 28/10/2026: `temperature` + tools e o padrão dão o
 * mesmo 400; `reasoning_effort: 'none'` + tools responde e chama a tool).
 * **gpt-6-sol e gpt-6.1-sol ficam de fora de propósito:** recusam `'none'`
 * ("Supported values are: 'low', 'medium', 'high'...") e com tools só funcionam
 * em `/v1/responses`. Mandar `'none'` para eles só trocaria um 400 por outro.
 */
import type OpenAI from 'openai';
import { semFornecedor } from '../services/openrouter';

type Amostragem = Pick<
  OpenAI.Chat.Completions.ChatCompletionCreateParams,
  'temperature' | 'reasoning_effort'
>;

/** Formato unificado do OpenRouter para esforço de raciocínio (ele traduz para cada fornecedor). */
type AmostragemOpenRouter = { reasoning: { effort: 'none' | 'low' } };

/**
 * Pelo OpenRouter o id vem com fornecedor (`openai/gpt-6-luna`, 31/10/2026): a regra da
 * família vale do mesmo jeito, mas o esforço vai no campo `reasoning` dele, não em
 * `reasoning_effort`. Modelo de outro fornecedor (deepseek, qwen…) segue com temperatura.
 */
export function amostragemDoModelo(modelo: string, temperature: number): Amostragem | AmostragemOpenRouter {
  const base = semFornecedor(modelo);
  // Claude 5.x pelo OpenRouter: `temperature` dá erro e o raciocínio vem ligado por padrão
  // (mais token e mais demora a cada rodada). `low` é o que a Anthropic indica para
  // executor e chat. No caminho direto da Anthropic nada disso é mandado.
  if (base !== modelo && /^claude-(haiku|sonnet|opus)-5\b/.test(base)) return { reasoning: { effort: 'low' } };
  if (/^gpt-5\.6\b/.test(base) || /^gpt-6-luna\b/.test(base) || /^gpt-6\.1-terra\b/.test(base)) {
    if (base !== modelo) return { reasoning: { effort: 'none' } };
    // A API aceita `'none'` desde a família 5.6, mas o `ReasoningEffort` do SDK
    // instalado ainda não o lista. O cast fica restrito a este ponto: subir a
    // versão do SDK só por causa de um literal de string mexeria no contrato de
    // todas as outras chamadas.
    return { reasoning_effort: 'none' as Amostragem['reasoning_effort'] };
  }
  return { temperature };
}
