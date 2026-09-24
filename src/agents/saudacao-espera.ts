// Cumprimento respondido antes da pergunta.
//
// O cliente manda "Boa tarde" e, segundos depois, a pergunta. Se a pergunta não
// cai no mesmo agrupamento do n8n, o agente responde o cumprimento sozinho ("O que
// você precisa hoje?") enquanto a pergunta já está na conversa, e só no turno
// seguinte responde de verdade. Medido em 21–24/09/2026 na Duda: 18 casos em 3 dias
// (ex.: lead 5e5976b0, 24/09 15:00:01 "Boa tarde" / 15:00:13 a pergunta / 15:00:18
// "Boa tarde! Como posso te ajudar?").
//
// Regra: turno que é SÓ cumprimento/despedida (isGreetingOrFarewell) confere se há
// fala do cliente fora deste turno. Havendo, o turno fica calado (mensagens: []) e
// o turno da pergunta, que vem logo atrás, responde tudo. Mora aqui, e não no
// orchestrator, para ser testável sem as env vars do servidor.

import type { MensagemDoCliente } from './cruzamento';

/** Quanto o turno de cumprimento espera por uma fala nova antes de responder. 0 = não espera. */
export const SAUDACAO_ESPERA_MS = Number(process.env.SAUDACAO_ESPERA_MS ?? 5_000);

/** Janela antes do início do turno em que uma fala pode ter ficado fora do agrupamento do n8n. */
export const JANELA_ANTES_MS = 13_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DepsSaudacao {
  getMensagensDoCliente(conversationId: string, desdeIso: string, ateIso: string): Promise<MensagemDoCliente[]>;
  esperar(ms: number): Promise<void>;
  agora?: () => number;
}

/**
 * Fala do cliente que NÃO está neste turno:
 * - qualquer mensagem criada depois que o turno começou;
 * - texto criado pouco antes do início que não aparece em `clientMessages`.
 * Mídia anterior ao início não conta: a do próprio turno chega sem texto.
 */
export function falaForaDoTurno(msgs: MensagemDoCliente[], inicioTurno: number, clientMessages: string): boolean {
  const turno = clientMessages.toLowerCase();
  return msgs.some((m) => {
    const t = Date.parse(m.created_at);
    if (Number.isNaN(t)) return false;
    if (t > inicioTurno) return true;
    const texto = (m.content ?? '').trim().toLowerCase();
    return m.message_type === 'text' && texto !== '' && !turno.includes(texto);
  });
}

/**
 * `true` = há fala do cliente fora deste turno de cumprimento; o turno deve calar.
 * Fail-open: erro de leitura devolve `false` e o turno responde como antes.
 */
export async function cumprimentoDeveCalar(
  deps: DepsSaudacao,
  p: { conversationId: string; inicioTurno: number; clientMessages: string; esperaMs?: number },
): Promise<boolean> {
  if (!UUID.test(p.conversationId)) return false;
  const agora = deps.agora ?? Date.now;
  const consultar = async () =>
    falaForaDoTurno(
      await deps.getMensagensDoCliente(
        p.conversationId,
        new Date(p.inicioTurno - JANELA_ANTES_MS).toISOString(),
        new Date(agora()).toISOString(),
      ),
      p.inicioTurno,
      p.clientMessages,
    );
  try {
    if (await consultar()) return true;
    const espera = p.esperaMs ?? SAUDACAO_ESPERA_MS;
    if (espera <= 0) return false;
    await deps.esperar(espera);
    return await consultar();
  } catch (err) {
    console.error('[Saudação] conferência falhou, turno responde normal:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
