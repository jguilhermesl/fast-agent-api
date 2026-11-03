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
/**
 * 1 h para o que não muda entre turnos (ferramentas e system). Medido em 03/11/2026: 86%
 * das chamadas grandes da Duda eram o prefixo fixo (~25 mil tokens) frio depois de 5 min
 * sem turno, reescrito a 1,25x. Escrita de 1 h custa 2x, leitura igual (0,1x). A API exige
 * as marcas de 1 h antes das de 5 min: ferramentas e system vêm antes das mensagens.
 * Conferido com chamada real (sem header beta): `cache_creation.ephemeral_1h_input_tokens`.
 */
const EFEMERO_1H = { type: 'ephemeral', ttl: '1h' } as const;

/**
 * Separa o system que o n8n monta em parte fixa e parte do turno.
 *
 * Medido em 16/10/2026 na primeira hora da Duda no claude-sonnet-5-5: 69 mil tokens
 * de entrada por turno, só 61% do cache, US$ 0,066 por turno (3x o gpt-5.4). Causa:
 * o fim do system traz `<dados_usuario>` com nome, telefone e o HORÁRIO COM MINUTO,
 * mais estágio do CRM e intenções executadas. A Anthropic só reaproveita prefixo
 * idêntico até a marca, então a persona inteira (~15 mil tokens) era escrita de novo
 * a cada turno e nenhuma conversa aproveitava a outra. A OpenAI cacheia o prefixo
 * igual sozinha, por isso o gpt-5.4 não sentia.
 *
 * A parte fixa (até `<dados_usuario>`) fica no system com cache, igual para todas as
 * conversas do agente; o resto vai junto da mensagem do cliente deste turno.
 */
export const INICIO_DO_TRECHO_DO_TURNO = '<dados_usuario>';

export function separarSystemDoTurno(system: string): { fixo: string; doTurno: string } {
  const i = system.indexOf(INICIO_DO_TRECHO_DO_TURNO);
  if (i <= 0) return { fixo: system, doTurno: '' };
  return { fixo: system.slice(0, i).trimEnd(), doTurno: system.slice(i).trim() };
}

export function systemComCache(texto: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: texto, cache_control: EFEMERO_1H } as unknown as Anthropic.TextBlockParam];
}

export function ferramentasComCache<T extends object>(ferramentas: T[]): T[] {
  if (!ferramentas.length) return ferramentas;
  const copia = ferramentas.slice();
  copia[copia.length - 1] = { ...copia[copia.length - 1], cache_control: EFEMERO_1H };
  return copia;
}

/**
 * Fim marcado (como `mensagensComMarcadorNoFim`) e também o 1º bloco da mensagem do
 * turno (`indiceDoTurno` = posição da mensagem do cliente). Medido em 03/11/2026: só com a
 * marca no fim, a rodada 0 marcava o LEMBRETE_EXECUTOR, bloco que a rodada 1 não tem; o
 * prefixo com a mensagem do turno era escrito a 1,25x e nunca lido. Com a marca no bloco
 * do turno a rodada 1 lê o que a rodada 0 escreveu. Total de marcas: ferramentas, system,
 * turno, fim = 4, o limite da API. Índice inválido ou bloco vazio: só o fim, como antes.
 */
export function mensagensComMarcadores(mensagens: Anthropic.MessageParam[], indiceDoTurno: number): Anthropic.MessageParam[] {
  const comFim = mensagensComMarcadorNoFim(mensagens);
  const alvo = comFim[indiceDoTurno];
  if (!alvo || alvo.role !== 'user') return comFim;
  const blocos: Array<Record<string, unknown>> =
    typeof alvo.content === 'string'
      ? [{ type: 'text', text: alvo.content }]
      : alvo.content.map((b) => ({ ...(b as unknown as Record<string, unknown>) }));
  const primeiro = blocos[0];
  if (!primeiro || primeiro.type !== 'text' || !String(primeiro.text ?? '').trim()) return comFim;
  blocos[0] = { ...primeiro, cache_control: EFEMERO };
  const copia = comFim.slice();
  copia[indiceDoTurno] = { ...alvo, content: blocos as unknown as Anthropic.MessageParam['content'] };
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
