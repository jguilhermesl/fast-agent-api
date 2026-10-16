/**
 * Executor obrigatório na rodada 0 quando o modelo da Anthropic não aceita forçar ferramenta.
 *
 * O Orquestrador força `chamar_executor` na rodada 0 (fora saudação e despedida):
 * valor, data e disponibilidade só podem vir do retorno do Executor. Na OpenAI isso é
 * `tool_choice: 'required'`; na Anthropic era `{ type: 'any' }`. Medido em 16/10/2026:
 * o claude-sonnet-5-5 recusa com 400 "tool_choice: type \"tool\" and \"any\" are not
 * supported for this model", e o turno inteiro caía no fallback.
 *
 * Para esses modelos: `tool_choice: auto` + uma instrução interna no fim da mensagem do
 * cliente (só na chamada, nunca no histórico). Se mesmo assim a rodada 0 terminar sem
 * ferramenta, o Orquestrador repete uma vez com a instrução firme.
 */
import type Anthropic from '@anthropic-ai/sdk';

export const LEMBRETE_EXECUTOR =
  '[Instrução interna deste turno, não é do cliente: antes de responder, chame a ferramenta chamar_executor com as tarefas que este pedido precisa. Valor, data, disponibilidade e qualquer dado da clínica só saem do retorno dela.]';

export const LEMBRETE_EXECUTOR_FIRME =
  '[Instrução interna: a resposta anterior saiu sem chamar chamar_executor e foi descartada. Chame chamar_executor agora; a resposta ao cliente vem depois do retorno.]';

/** Cópia das mensagens com um bloco de texto a mais no fim da última (a mensagem do cliente). */
export function comLembrete(mensagens: Anthropic.MessageParam[], texto: string): Anthropic.MessageParam[] {
  if (!mensagens.length) return mensagens;
  const ultima = mensagens[mensagens.length - 1];
  const blocos: Array<Record<string, unknown>> =
    typeof ultima.content === 'string'
      ? [{ type: 'text', text: ultima.content }]
      : ultima.content.map((b) => ({ ...(b as unknown as Record<string, unknown>) }));
  blocos.push({ type: 'text', text: texto });
  return [...mensagens.slice(0, -1), { ...ultima, content: blocos as unknown as Anthropic.MessageParam['content'] }];
}

/** O 400 que a Anthropic devolve quando o modelo não aceita `tool_choice` any/tool. */
export function ehRecusaDeFerramentaForcada(erro: unknown): boolean {
  const status = (erro as { status?: number })?.status;
  const texto = String((erro as { message?: string })?.message ?? erro);
  return (status === undefined || status === 400) && /tool_choice/i.test(texto) && /not supported/i.test(texto);
}
