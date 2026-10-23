/**
 * Robô do outro lado da conversa (23/10/2026).
 *
 * Em 08/10/2026 a Carol respondeu por ~5 h a uma resposta automática que repetia
 * "Hello, I'm sorry we cannot provide you with services for the time being": 764 turnos,
 * US$ 10,98, 480 buscas vazias na base. Em 09/10, outra conversa dela alternou 4 frases
 * em 63 mensagens numa hora. O GPT Maker tem um limite de interações por atendimento
 * para isso; aqui a trava olha **repetição**, não volume, porque gente de verdade quase
 * não repete texto: a hora humana mais cheia dos 30 dias teve 46 mensagens e 44 textos
 * diferentes.
 *
 * Regra (só mensagens de texto do cliente, última hora):
 *  - 10+ textos com até 2 diferentes, ou
 *  - 20+ textos com no máximo 1 diferente para cada 8.
 * Simulada em todas as mensagens de 30 dias: barra só os dois loops da Carol (o primeiro
 * a partir do 3º minuto) e nenhuma conversa humana. Áudio, foto e figurinha chegam com
 * texto vazio e não contam (sem esse filtro, 7 conversas da Duda com áudios seguidos
 * seriam barradas).
 */

export const JANELA_LOOP_MS = 60 * 60 * 1000;

export interface MensagemRecebida {
  message_type: string | null;
  content: string | null;
}

export interface DecisaoLoop {
  loop: boolean;
  textos: number;
  distintos: number;
  regra?: 'repeticao' | 'poucas_frases';
}

export function normalizarTexto(texto: string): string {
  return texto.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function decidirLoopRobo(mensagens: MensagemRecebida[]): DecisaoLoop {
  const textos = mensagens
    .filter((m) => m.message_type === 'text')
    .map((m) => normalizarTexto(m.content ?? ''))
    .filter((t) => t.length >= 2);
  const n = textos.length;
  const d = new Set(textos).size;
  if (n >= 10 && d <= 2) return { loop: true, textos: n, distintos: d, regra: 'repeticao' };
  if (n >= 20 && d * 8 <= n) return { loop: true, textos: n, distintos: d, regra: 'poucas_frases' };
  return { loop: false, textos: n, distintos: d };
}
