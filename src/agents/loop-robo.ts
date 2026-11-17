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
 *
 * Loop LENTO (17/11/2026): a Diana (Tisnat) ficou 5 dias respondendo o robô da Claro, que
 * mandava a mesma frase ~5 vezes por hora (517 mensagens, 516 iguais, US$ 4,60): nunca
 * chegou a 10 na hora. Segunda janela, de 24 h: 24+ textos com no máximo 2 diferentes.
 * Simulada em 30 dias (por dia corrido e por dia deslocado em 12 h): pega só a Diana/Claro;
 * nenhuma conversa humana teve sequer 6 textos com até 3 diferentes num dia (o mais
 * repetido foi um robô de status do Leandro: 9 textos, 3 diferentes). Humano com "ok",
 * "sim" e "bom dia" espalhados tem dezenas de textos diferentes ao lado.
 */

export const JANELA_LOOP_MS = 60 * 60 * 1000;
export const JANELA_LOOP_LENTO_MS = 24 * 60 * 60 * 1000;
export const LOOP_LENTO_MIN_TEXTOS = 24;
export const LOOP_LENTO_MAX_DISTINTOS = 2;

export interface MensagemRecebida {
  message_type: string | null;
  content: string | null;
  created_at?: string | null;
}

export interface DecisaoLoop {
  loop: boolean;
  textos: number;
  distintos: number;
  regra?: 'repeticao' | 'poucas_frases' | 'lento';
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

/** Loop lento: mensagens das últimas 24 h (qualquer ritmo), 24+ textos com até 2 diferentes. */
export function decidirLoopLento(mensagens: MensagemRecebida[]): DecisaoLoop {
  const textos = mensagens
    .filter((m) => m.message_type === 'text')
    .map((m) => normalizarTexto(m.content ?? ''))
    .filter((t) => t.length >= 2);
  const n = textos.length;
  const d = new Set(textos).size;
  if (n >= LOOP_LENTO_MIN_TEXTOS && d <= LOOP_LENTO_MAX_DISTINTOS) return { loop: true, textos: n, distintos: d, regra: 'lento' };
  return { loop: false, textos: n, distintos: d };
}

/**
 * Decisão do turno a partir das mensagens das últimas 24 h (uma consulta só): primeiro a
 * regra da última hora, que continua igual; se não pegou, a de 24 h.
 */
export function decidirLoopRoboTurno(mensagens: MensagemRecebida[], agora = Date.now()): DecisaoLoop {
  const corteHora = agora - JANELA_LOOP_MS;
  const daHora = mensagens.filter((m) => {
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    return Number.isNaN(t) || t >= corteHora;
  });
  const rapido = decidirLoopRobo(daHora);
  if (rapido.loop) return rapido;
  const lento = decidirLoopLento(mensagens);
  return lento.loop ? lento : rapido;
}
