// Detecção de mensagem cruzada: o cliente escreveu ANTES de receber a resposta anterior.
//
// Como acontece: o n8n junta as mensagens do cliente num buffer Redis e, quando
// a janela fecha (BufferDelay − 1 s depois da última), APAGA o buffer e chama
// /api/chat. O que o cliente manda enquanto este turno ainda pensa abre um
// buffer novo e vira o turno seguinte — que chega aqui já com a resposta
// anterior no histórico, mas sem o modelo saber que o cliente ainda não a
// tinha lido. Medido em 21–24/09/2026 (1.064 turnos, tempos exatos das
// execuções do n8n): esta regra marca 98 de 982 turnos da Duda (10,0%), nenhum
// com a fala marcada pertencendo ao turno anterior. Exemplo: lista de combos
// repetida em 79f78950 depois de "E quais valores", escrito 4,9 s antes de a
// primeira lista sair.
//
// Mora fora do orchestrator pelo mesmo motivo de `saudacao.ts`/`entrada.ts`:
// a decisão é pura e tem que ser testável sem as env vars do servidor. As
// leituras (Redis, Supabase) entram por `DepsCruzamento`.

import { limparEventosDoProvedor } from './entrada';

/** Início e fim (epoch ms, relógio da API) do último turno da conversa. */
export interface RegistroTurno {
  inicio: number;
  fim: number;
}

/** Linha de `messages` (direction = inbound) — só o que a regra usa. */
export interface MensagemDoCliente {
  created_at: string;
  message_type: string | null;
  content: string | null;
}

/**
 * Só procura cruzamento se o turno anterior acabou há no máximo isto. Medido
 * (744 pares): 92 de 93 cruzamentos começaram ≤ 45 s depois do fim do turno
 * anterior. Janela maior quase não acha mais nada e manda mais turnos ao banco
 * (27% dos turnos com 45 s, 51% com 120 s). Cobre com folga o BufferDelay de
 * 30 s de seis agentes ativos (o 2º turno sai ≥ BufferDelay − 1 s depois da
 * última fala).
 */
export const JANELA_CRUZAMENTO_MS = 45_000;

/**
 * Folga antes do início do turno anterior. O n8n apaga o buffer ~0,3 s antes de
 * chamar a API, então mensagem desse intervalo já é do turno seguinte. Não pode
 * passar de 2 s: o menor BufferDelay ativo é 3 s (João), e a última mensagem do
 * próprio turno anterior fica pelo menos BufferDelay − 1 s antes do fechamento.
 */
export const FOLGA_ANTES_MS = 1_000;

/**
 * Folga depois do fim do turno anterior: a 1ª mensagem da resposta é gravada
 * ~0,3 s depois do fim do /api/chat e ainda leva um tempo até o cliente ler.
 * Ninguém lê e responde em 2 s.
 */
export const FOLGA_DEPOIS_MS = 2_000;

/** Tipos que o n8n transforma em fala. Reação, edição, apagamento ficam de fora. */
const TIPOS_DE_FALA = new Set(['text', 'audio', 'image', 'document', 'video']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Intervalo de `created_at` onde uma fala do cliente cruzou com a resposta anterior. */
export function janelaDeCruzamento(
  anterior: RegistroTurno | null,
  agora: number,
): { desde: number; ate: number } | null {
  if (!anterior) return null;
  if (agora - anterior.fim > JANELA_CRUZAMENTO_MS) return null;
  return { desde: anterior.inicio - FOLGA_ANTES_MS, ate: anterior.fim + FOLGA_DEPOIS_MS };
}

/** Alguma fala do cliente caiu entre o fechamento do buffer anterior e a chegada da resposta? */
export function houveCruzamento(
  mensagens: MensagemDoCliente[],
  janela: { desde: number; ate: number },
): boolean {
  return mensagens.some((m) => {
    if (!TIPOS_DE_FALA.has(m.message_type ?? '')) return false;
    if (m.message_type === 'text' && !limparEventosDoProvedor(m.content ?? '')) return false;
    const t = new Date(m.created_at).getTime();
    return Number.isFinite(t) && t >= janela.desde && t <= janela.ate;
  });
}

export type MotivoCruzamento = 'fila' | 'tempo';

export interface DepsCruzamento {
  getUltimoTurno(scopedClientId: string): Promise<RegistroTurno | null>;
  getMensagensDoCliente(conversationId: string, desdeIso: string, ateIso: string): Promise<MensagemDoCliente[]>;
  agora?: () => number;
}

/**
 * Este turno responde fala escrita antes da resposta anterior chegar?
 *
 * - `fila`: outro turno da mesma conversa ainda rodava quando este chegou
 *   (esperou na fila) — a fala é necessariamente anterior à resposta.
 * - `tempo`: o turno anterior já tinha acabado, mas há fala do cliente dentro
 *   da janela de cruzamento (tabela `messages`, relógio do banco).
 *
 * Fail-open: qualquer erro de leitura devolve `null`, que é o comportamento de
 * antes deste módulo (turno sem aviso).
 */
export async function detectarCruzamento(
  deps: DepsCruzamento,
  p: { scopedClientId: string; conversationId: string; esperouNaFila: boolean },
): Promise<MotivoCruzamento | null> {
  if (p.esperouNaFila) return 'fila';
  // Suíte de avaliação manda conversation_id que não é UUID ("suite-…"): a
  // coluna é uuid e a consulta só devolveria erro.
  if (!UUID.test(p.conversationId)) return null;
  try {
    const janela = janelaDeCruzamento(await deps.getUltimoTurno(p.scopedClientId), (deps.agora ?? Date.now)());
    if (!janela) return null;
    const msgs = await deps.getMensagensDoCliente(
      p.conversationId,
      new Date(janela.desde).toISOString(),
      new Date(janela.ate).toISOString(),
    );
    return houveCruzamento(msgs, janela) ? 'tempo' : null;
  } catch (err) {
    console.error('[Cruzamento] detecção falhou, turno segue sem aviso:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Aviso para o modelo, no mesmo formato da pré-classificação de objeção em
 * `formatClientMessage`. Não vai para o histórico nem para o Executor.
 */
export const NOTA_CRUZAMENTO =
  '[CONTEXTO AUTOMÁTICO: as mensagens se cruzaram. O cliente escreveu o texto abaixo ANTES de receber a sua última resposta. ' +
  'Não repita lista, valor ou informação que a sua última resposta já trouxe; se ela já responde, confirme em uma frase curta e siga para o próximo passo. ' +
  'Se o texto traz algo novo, responda só o que falta. Não cumprimente de novo.]';

export function comNotaDeCruzamento(texto: string): string {
  return `${NOTA_CRUZAMENTO}\n\n${texto}`;
}
