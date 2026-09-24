/**
 * Fila única de turnos por conversa (`agent_id:contact_phone`).
 *
 * O n8n apaga o buffer de mensagens na hora em que chama /api/chat. Mensagem
 * que chega depois abre outro buffer e vira outro turno, que pode bater aqui
 * enquanto o primeiro ainda roda. Os dois leem o histórico do Redis antes de
 * qualquer um gravar, e o segundo responde sem ver a resposta do primeiro.
 * Medido em 21–24/09/2026 (744 pares de turnos, tempos das execuções do n8n):
 * 1 caso — 897df853, a imagem demorou na análise, escapou do buffer e o 2º
 * turno começou 5,6 s antes do 1º terminar ("me manda a foto do pedido" e, 3 s
 * depois, "recebi sua guia"). Raro, mas é o único caso em que o 2º turno não
 * tem como saber o que o 1º disse.
 *
 * Lock no Redis (SET NX PX com token) e não mutex em memória: o Railway roda 1
 * réplica, mas no deploy o contêiner novo e o velho convivem alguns segundos.
 *
 * Fail-open em tudo: Redis fora, ou espera maior que `esperaMaxMs`, e o turno
 * segue sem lock — o comportamento de antes deste módulo. Deixar o cliente sem
 * resposta por causa da fila seria pior que o defeito que ela evita.
 *
 * Custo no caso comum (ninguém na frente): 1 SET NX + 1 EVAL de liberação.
 */

import { randomUUID } from 'crypto';

/**
 * Quanto um turno espera o anterior da mesma conversa. `0` desliga a fila sem
 * redeploy. 30 s cobre o p99 medido do /api/chat (23 s; máx. 32 s) e, como o
 * orçamento do turno (services/deadline.ts) começa a contar ANTES da espera,
 * sobra ≥ 60 s para o turno em si e o n8n nunca espera mais que os 90 s de hoje.
 */
export const TURN_LOCK_WAIT_MS = Number(process.env.TURN_LOCK_WAIT_MS ?? 30_000);

export interface LockStore {
  /** SET key value PX ttlMs NX. `true` se pegou. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Apaga só se o valor ainda for `value`: nunca solta o lock de outro turno. */
  delIfEquals(key: string, value: string): Promise<void>;
}

export interface Vez {
  /** `null` = seguiu sem lock (fila desligada, Redis fora ou espera estourada). */
  token: string | null;
  esperouMs: number;
  /** Havia outro turno da mesma conversa rodando quando este chegou. */
  concorrente: boolean;
}

export interface OpcoesFila {
  /** Validade do lock. Tem que passar do turno mais longo possível. */
  ttlMs: number;
  esperaMaxMs: number;
  intervaloMs?: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  gerarToken?: () => string;
}

export function chaveDaFila(scopedClientId: string): string {
  return `fila:turno:${scopedClientId}`;
}

const dormirDeVerdade = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function entrarNaFila(store: LockStore, scopedClientId: string, opts: OpcoesFila): Promise<Vez> {
  if (!(opts.esperaMaxMs > 0)) return { token: null, esperouMs: 0, concorrente: false };

  const agora = opts.agora ?? Date.now;
  const dormir = opts.dormir ?? dormirDeVerdade;
  const intervalo = opts.intervaloMs ?? 200;
  const token = (opts.gerarToken ?? randomUUID)();
  const chave = chaveDaFila(scopedClientId);
  const inicio = agora();
  let concorrente = false;

  for (;;) {
    let pegou: boolean;
    try {
      pegou = await store.setNx(chave, token, opts.ttlMs);
    } catch (err) {
      console.error(`[Fila] Redis falhou, turno segue sem lock (${scopedClientId}):`, err instanceof Error ? err.message : String(err));
      return { token: null, esperouMs: agora() - inicio, concorrente };
    }
    if (pegou) return { token, esperouMs: agora() - inicio, concorrente };

    concorrente = true;
    const esperou = agora() - inicio;
    if (esperou >= opts.esperaMaxMs) {
      console.warn(`[Fila] turno anterior não terminou em ${opts.esperaMaxMs}ms, este segue sem lock (${scopedClientId})`);
      return { token: null, esperouMs: esperou, concorrente };
    }
    await dormir(Math.min(intervalo, opts.esperaMaxMs - esperou));
  }
}

export async function sairDaFila(store: LockStore, scopedClientId: string, vez: Vez): Promise<void> {
  if (!vez.token) return;
  try {
    await store.delIfEquals(chaveDaFila(scopedClientId), vez.token);
  } catch (err) {
    // O TTL solta o lock sozinho; o próximo turno só espera mais.
    console.error(`[Fila] não liberou o lock (${scopedClientId}):`, err instanceof Error ? err.message : String(err));
  }
}
