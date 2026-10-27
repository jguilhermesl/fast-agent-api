// Memória por conversa (`agents.prompt_config.memoria_por_conversa: true`).
//
// O histórico mora em `agent_id:telefone` e atravessa leads: conversa nova do mesmo
// telefone (lead apagado, lead encerrado e recriado) herdava as falas da anterior. Na
// Canda (24/10/2026) a apresentação de uma conversa de teste apagada ficou no histórico
// e o modelo se apresentou de novo no meio da conversa real.
//
// Com a chave ligada, cada turno compara o `conversation_id` com o último que usou a
// memória. Mudou: o histórico vai para `memoria:anterior:*` (30 dias, para consulta) e a
// conversa nova começa vazia. Sem marcador (memória de antes da chave): não corta, só
// marca, para não apagar a conversa em andamento no dia em que a chave liga.

export interface MemoriaStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export type CorteMemoria = 'mesma' | 'marcou' | 'cortou';

const TTL_SECONDS = 2_592_000;

export const chaveMarcador = (scopedClientId: string) => `memoria:conversa:${scopedClientId}`;
export const chaveAnterior = (scopedClientId: string) => `memoria:anterior:${scopedClientId}`;

export async function cortarSeConversaNova(
  store: MemoriaStore,
  scopedClientId: string,
  conversationId: string,
): Promise<CorteMemoria> {
  const marcador = await store.get(chaveMarcador(scopedClientId));
  if (marcador === conversationId) return 'mesma';

  if (marcador !== null) {
    const historico = await store.get(scopedClientId);
    if (historico !== null) {
      await store.set(chaveAnterior(scopedClientId), historico, TTL_SECONDS);
      await store.del(scopedClientId);
    }
  }
  await store.set(chaveMarcador(scopedClientId), conversationId, TTL_SECONDS);
  return marcador === null ? 'marcou' : 'cortou';
}
