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
 */
import type OpenAI from 'openai';

type Amostragem = Pick<
  OpenAI.Chat.Completions.ChatCompletionCreateParams,
  'temperature' | 'reasoning_effort'
>;

export function amostragemDoModelo(modelo: string, temperature: number): Amostragem {
  if (/^gpt-5\.6\b/.test(modelo)) {
    // A API aceita `'none'` desde a família 5.6, mas o `ReasoningEffort` do SDK
    // instalado ainda não o lista. O cast fica restrito a este ponto: subir a
    // versão do SDK só por causa de um literal de string mexeria no contrato de
    // todas as outras chamadas.
    return { reasoning_effort: 'none' as Amostragem['reasoning_effort'] };
  }
  return { temperature };
}
