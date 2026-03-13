import Redis from 'ioredis';
import { config } from '../config';
import type { ChatMessage } from '../types';

const redis = new Redis(config.redisUrl, { lazyConnect: true });

redis.on('error', (err) => console.error('[Redis] Connection error:', err.message));

// TTL 30 dias (igual ao n8n)
const TTL_SECONDS = 2_592_000;

function historyKey(scopedClientId: string): string {
  return `chat:history:${scopedClientId}`;
}

// Busca o histórico da conversa (últimas N mensagens)
export async function getHistory(
  scopedClientId: string,
  limit = 18
): Promise<ChatMessage[]> {
  try {
    const raw = await redis.get(historyKey(scopedClientId));
    if (!raw) return [];
    const messages: ChatMessage[] = JSON.parse(raw);
    // Retorna as últimas `limit` mensagens
    return messages.slice(-limit);
  } catch (err) {
    console.error('[Redis] getHistory error:', err);
    return [];
  }
}

// Adiciona mensagens ao histórico e renova TTL
export async function appendHistory(
  scopedClientId: string,
  newMessages: ChatMessage[]
): Promise<void> {
  try {
    const raw = await redis.get(historyKey(scopedClientId));
    const existing: ChatMessage[] = raw ? JSON.parse(raw) : [];
    const updated = [...existing, ...newMessages];

    await redis.set(
      historyKey(scopedClientId),
      JSON.stringify(updated),
      'EX',
      TTL_SECONDS
    );
  } catch (err) {
    console.error('[Redis] appendHistory error:', err);
  }
}

export async function connectRedis(): Promise<void> {
  await redis.connect();
  console.log('[Redis] Connected');
}

export default redis;
