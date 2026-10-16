/**
 * Cache de prompt da Anthropic no Orquestrador.
 *
 * A OpenAI cacheia prefixo sozinha; a Anthropic só cacheia o que vier marcado com
 * `cache_control`. Sem marca, cada rodada paga o prompt inteiro: na Duda são ~29 mil
 * tokens de entrada por turno (persona + texto fixo do n8n + histórico), e com o
 * Sonnet isso daria ~US$ 500/mês contra ~US$ 120 com cache (estimativa de 16/10/2026
 * no volume de outubro). Token lido do cache custa 1/10; escrito, 1,25x.
 *
 * Três marcas (o limite é quatro):
 *   1. a última ferramenta — cacheia a lista de ferramentas, que vem antes de tudo;
 *   2. o system — persona e sufixo de saída, iguais em toda chamada do agente;
 *   3. o fim da conversa, móvel — a rodada 1 (depois da resposta do Executor)
 *      reaproveita tudo o que a rodada 0 mandou, e o turno seguinte reaproveita o
 *      histórico até onde ele não mudou.
 *
 * Funções puras e sem mutação: o array de mensagens do loop segue sem marca, e a
 * cópia marcada é montada a cada chamada (marca velha não se acumula).
 */
import type Anthropic from '@anthropic-ai/sdk';

const EFEMERO = { type: 'ephemeral' } as const;

export function systemComCache(texto: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: texto, cache_control: EFEMERO } as unknown as Anthropic.TextBlockParam];
}

export function ferramentasComCache<T extends object>(ferramentas: T[]): T[] {
  if (!ferramentas.length) return ferramentas;
  const copia = ferramentas.slice();
  copia[copia.length - 1] = { ...copia[copia.length - 1], cache_control: EFEMERO };
  return copia;
}

export function mensagensComMarcadorNoFim(mensagens: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (!mensagens.length) return mensagens;
  const ultima = mensagens[mensagens.length - 1];
  const blocos: Array<Record<string, unknown>> =
    typeof ultima.content === 'string'
      ? [{ type: 'text', text: ultima.content }]
      : ultima.content.map((b) => ({ ...(b as unknown as Record<string, unknown>) }));
  if (!blocos.length) return mensagens;
  const fim = blocos[blocos.length - 1];
  // A API recusa bloco de texto vazio; sem texto, fica sem marca e a chamada segue igual.
  if (fim.type === 'text' && !String(fim.text ?? '').trim()) return mensagens;
  blocos[blocos.length - 1] = { ...fim, cache_control: EFEMERO };
  return [...mensagens.slice(0, -1), { ...ultima, content: blocos as unknown as Anthropic.MessageParam['content'] }];
}
