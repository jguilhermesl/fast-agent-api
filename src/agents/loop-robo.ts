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
 *
 * Reconhecimento pelo RABO da conversa (17/11/2026, card #1223): em 28/10 a Duda respondeu
 * 17 vezes em 10 min ao menu automático da B4 Telecom ("Opção não encontrada, por favor,
 * escolha uma das opções do menu"), US$ 0,68, até um atendente entrar. As regras de cima não
 * viram: a pessoa da empresa tinha conversado antes, na mesma hora, então havia 9 textos
 * diferentes na janela. `decidirRoboNoRabo` olha só as últimas mensagens recebidas:
 *  - eco: as 3 últimas são o mesmo texto de 60+ caracteres e já respondemos no meio;
 *  - automaticas: as 2 últimas têm cara de mensagem automática (agents/mensagem-automatica.ts)
 *    e não há fala de gente esperando resposta.
 * Simulado com este código em 30 dias (42.684 textos recebidos, 5.731 conversas): 7 conversas
 * pegas, todas robô. eco: Claro (na 3ª mensagem, não na 24ª), B4 e uma propaganda da Vivo.
 * automaticas: B4 (pausa na 2ª mensagem do robô: 1 resposta em vez de 17), Shopee e três menus
 * de empresa. Nenhuma conversa de gente. O que ficou de fora de propósito: 2 textos iguais
 * (paciente repete nome, pergunta e o texto do anúncio; parceiro repete o pedido) e 3 iguais
 * curtos ("pode mandar" 3 vezes, "Olá! Tenho interesse em agendar uma consulta, por favor." 3 vezes).
 * Uma mensagem automática sozinha também não pausa: paciente encaminha cobrança e aviso
 * automático para perguntar sobre eles.
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
  regra?: 'repeticao' | 'poucas_frases' | 'lento' | 'eco' | 'automaticas';
}

export const ECO_MIN_REPETICOES = 3;
export const ECO_MIN_CARACTERES = 60;
export const AUTOMATICAS_SEGUIDAS = 2;

/** Mensagem da conversa, nas duas direções (o mesmo formato de `getUltimasMensagensDaConversa`). */
export interface MensagemDaLinha {
  direction: string;
  message_type: string | null;
  content: string | null;
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

/**
 * Robô reconhecido pelas últimas mensagens da conversa. `linha` vem em ordem cronológica,
 * com as duas direções; mensagem de sistema não conta.
 *
 * - `eco`: as 3 últimas recebidas (ou mais) são o mesmo texto longo e nós já mandamos algo
 *   depois da primeira delas. É o pingue-pongue: respondemos e voltou igual. Sem a nossa saída
 *   no meio seria só alguém colando a mesma pergunta três vezes enquanto espera (a rajada
 *   descarta o turno e o seguinte responde tudo).
 * - `automaticas`: as 2 últimas recebidas são texto com cara de mensagem automática e tudo
 *   o que chegou depois da nossa última saída também é. Se há fala de gente sem resposta
 *   no meio (pergunta do paciente seguida da saudação automática do WhatsApp dele), o turno segue.
 *
 * Volta sozinho: basta chegar um texto diferente (eco) ou uma fala que não seja automática.
 */
export function decidirRoboNoRabo(linha: MensagemDaLinha[], pareceAutomatica: (texto: string) => boolean): DecisaoLoop {
  const msgs = linha.filter((m) => m.message_type !== 'system');
  const recebidas: number[] = [];
  let ultimaSaida = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].direction === 'inbound') recebidas.push(i);
    else if (msgs[i].direction === 'outbound' && ultimaSaida < 0) ultimaSaida = i;
  }
  const nao: DecisaoLoop = { loop: false, textos: 0, distintos: 0 };
  if (!recebidas.length) return nao;

  const textoDe = (i: number): string => (msgs[i].message_type === 'text' ? normalizarTexto(msgs[i].content ?? '') : '');

  const alvo = textoDe(recebidas[0]);
  if (alvo.length >= ECO_MIN_CARACTERES) {
    let iguais = 0;
    for (const i of recebidas) {
      if (textoDe(i) !== alvo) break;
      iguais++;
    }
    // Saída nossa depois da mais velha da sequência inteira (não só das 3 últimas): com a IA
    // pausada a sequência cresce sem resposta nova, e a pausa tem de continuar.
    if (iguais >= ECO_MIN_REPETICOES && ultimaSaida > recebidas[iguais - 1]) {
      return { loop: true, textos: iguais, distintos: 1, regra: 'eco' };
    }
  }

  const automaticas: string[] = [];
  for (const i of recebidas) {
    const t = textoDe(i);
    if (!t || !pareceAutomatica(msgs[i].content ?? '')) break;
    automaticas.push(t);
  }
  const semResposta = recebidas.filter((i) => i > ultimaSaida).length;
  if (automaticas.length >= AUTOMATICAS_SEGUIDAS && semResposta <= automaticas.length) {
    return { loop: true, textos: automaticas.length, distintos: new Set(automaticas).size, regra: 'automaticas' };
  }

  return nao;
}
