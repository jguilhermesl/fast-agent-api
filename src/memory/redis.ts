import Redis from 'ioredis';
import { config } from '../config';
import type { ChatMessage } from '../types';
import type { LockStore } from './fila';
import type { RegistroTurno } from '../agents/cruzamento';

const redis = new Redis(config.redisUrl, { lazyConnect: true, db: 1 });

redis.on('error', (err) => console.error('[Redis] Connection error:', err.message));

// TTL 30 dias (igual ao n8n)
const TTL_SECONDS = 2_592_000;

function historyKey(scopedClientId: string): string {
  return scopedClientId;
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

// ── Fila de turnos (memory/fila.ts) ───────────────────────────
// Chaves `fila:turno:*` e `turno:ultimo:*` não colidem com o histórico, cuja
// chave é o `agent_id:telefone` puro.

// Apaga só se o lock ainda for deste turno (compare-and-delete atômico).
const DEL_SE_IGUAL = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const lockStore: LockStore = {
  setNx: async (key, value, ttlMs) => (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
  delIfEquals: async (key, value) => {
    await redis.eval(DEL_SE_IGUAL, 1, key, value);
  },
};

// Último turno da conversa, lido pelo turno seguinte (agents/cruzamento.ts).
const TTL_ULTIMO_TURNO_SECONDS = 600;

export async function getUltimoTurno(scopedClientId: string): Promise<RegistroTurno | null> {
  try {
    const raw = await redis.get(`turno:ultimo:${scopedClientId}`);
    return raw ? (JSON.parse(raw) as RegistroTurno) : null;
  } catch (err) {
    console.error('[Redis] getUltimoTurno error:', err);
    return null;
  }
}

export async function setUltimoTurno(scopedClientId: string, registro: RegistroTurno): Promise<void> {
  try {
    await redis.set(`turno:ultimo:${scopedClientId}`, JSON.stringify(registro), 'EX', TTL_ULTIMO_TURNO_SECONDS);
  } catch (err) {
    console.error('[Redis] setUltimoTurno error:', err);
  }
}

export async function connectRedis(): Promise<void> {
  await redis.connect();
  console.log('[Redis] Connected');
}

export default redis;
