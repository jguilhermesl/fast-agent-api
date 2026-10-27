// Memória por conversa (`agents.prompt_config.memoria_por_conversa: true`).
//
// O histórico mora em `agent_id:telefone` e atravessa leads: conversa nova do mesmo
// telefone (lead apagado, lead encerrado e recriado) herdava as falas da anterior. Na
// Canda (24/10/2026) a apresentação de uma conversa de teste apagada ficou no histórico
// e o modelo se apresentou de novo no meio da conversa real.
//
// Com a chave ligada, cada turno compara o `conversation_id` com o último que usou a
// memória. Mudou: o histórico vai para `memoria:anterior:*` (30 dias, para consulta) e a
// conversa nova começa vazia. Sem marcador (memória de antes da chave): corta só se a
// conversa ainda não tem nenhuma mensagem de saída (é o primeiro turno dela); conversa em
// andamento no dia em que a chave liga só ganha o marcador e segue com a memória.

export interface MemoriaStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export type CorteMemoria = 'mesma' | 'marcou' | 'cortou';

/** Só é chamada sem marcador: `true` = a conversa ainda não tem mensagem de saída. */
export type PrimeiroTurno = () => Promise<boolean>;

const TTL_SECONDS = 2_592_000;

export const chaveMarcador = (scopedClientId: string) => `memoria:conversa:${scopedClientId}`;
export const chaveAnterior = (scopedClientId: string) => `memoria:anterior:${scopedClientId}`;

export async function cortarSeConversaNova(
  store: MemoriaStore,
  scopedClientId: string,
  conversationId: string,
  primeiroTurno: PrimeiroTurno,
): Promise<CorteMemoria> {
  const marcador = await store.get(chaveMarcador(scopedClientId));
  if (marcador === conversationId) return 'mesma';

  const cortar = marcador !== null || (await primeiroTurno());
  if (cortar) {
    const historico = await store.get(scopedClientId);
    if (historico !== null) {
      await store.set(chaveAnterior(scopedClientId), historico, TTL_SECONDS);
      await store.del(scopedClientId);
    }
  }
  await store.set(chaveMarcador(scopedClientId), conversationId, TTL_SECONDS);
  return cortar ? 'cortou' : 'marcou';
}
