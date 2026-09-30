// Uma resposta por rajada: o turno que ficou velho antes de sair é descartado.
//
// Como a resposta dupla acontece: o n8n junta as mensagens do cliente e, quando
// a janela fecha, apaga o buffer e chama /api/chat. O que o cliente escreve
// enquanto este turno pensa abre OUTRO buffer, que vira outro turno. Os dois
// respondem: o primeiro sem saber da mensagem nova, o segundo em cima dele.
// Medido em 23–30/09/2026 (tráfego real, 1.840 turnos da IA): 170 respostas a
// mais para a mesma rajada, em 124 de 479 conversas (26%). A mensagem nova foi
// criada enquanto o /api/chat do turno anterior rodava em ~89 casos, na corrida
// do fechamento do buffer em ~47, depois do /api/chat (já no envio) em ~30 e por
// reinjeção em 4. O PR #22 (fila + aviso de cruzamento) só avisava o 2º turno;
// os dois continuavam respondendo.
//
// Regra: no fim do turno, antes de devolver ao n8n, se chegou fala do cliente
// que não está neste lote, o n8n já abriu (ou vai abrir) o turno dela. Este turno
// devolve `mensagens: []` (o n8n não envia nada: é o mesmo caminho do cumprimento
// calado), NÃO grava a resposta no histórico e deixa o texto do cliente como
// pendente no Redis. O turno seguinte junta o pendente à fala nova e responde
// tudo de uma vez, como se o n8n tivesse agrupado as duas.
//
// Só descarta quando é seguro refazer: sem transferência, sem ferramenta com
// efeito (agendar, enviar texto fixo/arquivo, encerrar), com a fila da conversa
// garantindo que o turno seguinte ainda não começou, e no máximo 2 vezes seguidas.
//
// Mora fora do orchestrator pelo mesmo motivo de `cruzamento.ts`: a decisão é
// pura e testável sem as env vars do servidor. As leituras entram por parâmetro.

import { limparEventosDoProvedor } from './entrada';

export type ModoRajada = 'descartar' | 'log' | 'off';
export type TipoMensagem = 'text' | 'image_analysis' | 'audio_transcription';

/** Linha de `messages` da conversa (as duas direções), só o que a regra usa. */
export interface MensagemDaConversa {
  created_at: string;
  direction: string;
  message_type: string | null;
  content: string | null;
  sender_name: string | null;
  from_device: boolean;
}

export interface EstadoDoLead {
  handled_by: string | null;
  status: string | null;
  ai_disabled: boolean;
}

/** Texto do cliente de um turno descartado, guardado para o turno seguinte. */
export interface Pendente {
  texto: string;
  tipo: TipoMensagem;
  /** epoch ms em que o turno foi descartado */
  em: number;
  /** quantos turnos seguidos já foram descartados nesta rajada */
  descartes: number;
}

/** Depois disto o turno responde mesmo com fala nova: o cliente não pode ficar sem resposta. */
export const LIMITE_DESCARTES_SEGUIDOS = 2;

/**
 * Folga para relógios diferentes (banco, n8n, Railway). A última mensagem do lote
 * fica pelo menos BufferDelay − 1 s antes do fechamento do buffer, que acontece
 * antes do início do turno aqui; texto criado depois de
 * `início − (BufferDelay − 1 s) + folga` não pode ser do lote.
 */
export const FOLGA_RELOGIO_MS = 1_500;

/**
 * Mídia não dá para comparar com o texto do lote (o lote traz a transcrição ou a
 * descrição, `messages` não). Só conta a criada depois de `início − 1 s`: nenhuma
 * mídia do lote chega tão tarde, porque transcrever/analisar leva segundos.
 */
export const FOLGA_MIDIA_MS = 1_000;

/**
 * O turno seguinte da conversa espera este na fila por até `TURN_LOCK_WAIT_MS` e
 * depois segue sem lock. Passado disso menos esta margem, ele pode já ter
 * começado sem ver o pendente: então este turno responde normalmente.
 */
export const MARGEM_FILA_MS = 3_000;

/** Pendente mais velho que isto é ignorado (a rajada acabou há muito). */
export const PENDENTE_VALIDADE_MS = 10 * 60_000;

const TIPOS_DE_FALA = new Set(['text', 'audio', 'image', 'document', 'video']);
const NAO_HUMANO = new Set(['AI', 'system']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Suíte manda conversation_id que não é UUID ("suite-…"): não vai ao banco. */
export function ehConversaReal(conversationId: string): boolean {
  return UUID.test(conversationId);
}

/**
 * Ferramenta que pode rodar de novo no turno seguinte sem efeito para o cliente
 * ou para a agenda: consultas, busca na base e etapa do CRM. Qualquer outra
 * (agendar, `enviar_*` que já mandou texto fixo ou arquivo, encerrar conversa,
 * cadastrar) segura a resposta: descartar deixaria o cliente sem a confirmação
 * do que foi feito.
 */
export function ferramentaSemEfeito(tool: string): boolean {
  return (
    /^(atualizar_lead_crm|agent_knowledge_base|buscar_conhecimento|chamar_executor)$/.test(tool) ||
    /^(conferir|consultar|buscar|verificar|listar)_/.test(tool) ||
    /^google_calendar_(horarios_disponiveis|listar_eventos)$/.test(tool)
  );
}

/** Minúsculas e espaços colapsados em cada linha; as quebras de linha ficam. */
const normalizarLinhas = (s: string) =>
  s.split('\n').map((l) => l.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/**
 * O n8n junta as mensagens do lote uma por linha. A fala está no lote se as
 * linhas dela aparecem inteiras, em sequência: "?" não casa com "grávida ?".
 */
function estaNoLote(lote: string, texto: string): boolean {
  const t = normalizarLinhas(texto);
  return t !== '' && `\n${lote}\n`.includes(`\n${t}\n`);
}

/**
 * Falas do cliente que não estão neste lote. Texto: criado depois da referência
 * do buffer e que não aparece no texto do lote. Mídia: criada depois de
 * `início − 1 s`. Reação, edição, apagamento e evento do provedor não contam
 * (não viram turno no n8n).
 */
export function falasNovas(
  msgs: MensagemDaConversa[],
  p: { inicio: number; bufferDelayMs: number | null; loteTexto: string },
): MensagemDaConversa[] {
  const desdeMidia = p.inicio - FOLGA_MIDIA_MS;
  const desdeTexto =
    p.bufferDelayMs && p.bufferDelayMs > 0
      ? Math.min(p.inicio - (p.bufferDelayMs - 1_000) + FOLGA_RELOGIO_MS, desdeMidia)
      : desdeMidia;
  const lote = normalizarLinhas(p.loteTexto);

  return msgs.filter((m) => {
    if (m.direction !== 'inbound') return false;
    const tipo = m.message_type ?? '';
    if (!TIPOS_DE_FALA.has(tipo)) return false;
    const t = Date.parse(m.created_at);
    if (!Number.isFinite(t)) return false;
    if (tipo !== 'text') return t > desdeMidia;
    const texto = limparEventosDoProvedor(m.content ?? '');
    if (!texto) return false;
    if (t <= desdeTexto) return false;
    // Já está neste lote (o buffer do n8n pode fechar pela hora da mídia e
    // levar junto um texto mais novo). Em dúvida, não é nova: responder duas
    // vezes é melhor que não responder.
    return !estaNoLote(lote, texto);
  });
}

/** Mensagem do atendente pelo celular criada durante o turno. Só vai para o log. */
export function humanoNoTurno(msgs: MensagemDaConversa[], inicio: number): number {
  return msgs.filter((m) => {
    if (m.direction !== 'outbound' || !m.from_device) return false;
    if (!m.sender_name || NAO_HUMANO.has(m.sender_name)) return false;
    if (!TIPOS_DE_FALA.has(m.message_type ?? '')) return false;
    const t = Date.parse(m.created_at);
    return Number.isFinite(t) && t > inicio - FOLGA_MIDIA_MS;
  }).length;
}

export interface EntradaRajada {
  /** início do turno na API (epoch ms, antes da fila) */
  inicio: number;
  agora: number;
  /** `prompt_config.delays.max_ms` do agente; `null` = não lido */
  bufferDelayMs: number | null;
  /** `client_messages` deste turno (já com o pendente, se houve) */
  loteTexto: string;
  /** ferramentas chamadas neste turno */
  tools: string[];
  redirect: boolean;
  /** quando este turno pegou o lock da conversa; `null` = seguiu sem lock */
  lockDesde: number | null;
  /** `TURN_LOCK_WAIT_MS` */
  esperaMaxFilaMs: number;
  /** descartes seguidos antes deste turno (do pendente que ele juntou) */
  descartesAnteriores: number;
  /**
   * Início do último turno já terminado desta conversa (`turno:ultimo`). Se é
   * posterior ao início deste, um turno mais novo passou na frente pela fila e
   * ninguém mais vai ler o pendente: este turno responde.
   */
  inicioUltimoTurno: number | null;
  /** `null` = leitura falhou */
  lead: EstadoDoLead | null;
  msgs: MensagemDaConversa[];
}

export type DecisaoRajada =
  | { acao: 'enviar'; motivo: string; novas: number; humano_no_turno: number }
  | { acao: 'descartar'; motivo: 'mensagem_nova' | 'lead_com_humano'; novas: number; humano_no_turno: number };

export function decidirRajada(e: EntradaRajada): DecisaoRajada {
  const humano = humanoNoTurno(e.msgs, e.inicio);
  const enviar = (motivo: string, novas = 0): DecisaoRajada => ({ acao: 'enviar', motivo, novas, humano_no_turno: humano });

  if (e.redirect) return enviar('transferencia');
  if (!e.tools.every(ferramentaSemEfeito)) return enviar('ferramenta_com_efeito');
  if (!e.lead) return enviar('lead_ilegivel');

  // O atendente assumiu: o n8n já não envia (Filtro_Inicial2 exige handled_by = ai).
  // Descartar aqui só impede que a memória guarde como dita uma resposta que não saiu.
  if (e.lead.handled_by !== 'ai') return { acao: 'descartar', motivo: 'lead_com_humano', novas: 0, humano_no_turno: humano };

  // Mensagem nova não vira turno com o lead em espera de humano ou com a IA desligada.
  if (e.lead.status === 'pending' || e.lead.ai_disabled) return enviar('lead_sem_turno_novo');

  const novas = falasNovas(e.msgs, { inicio: e.inicio, bufferDelayMs: e.bufferDelayMs, loteTexto: e.loteTexto }).length;
  if (novas === 0) return enviar('sem_mensagem_nova');
  if (e.descartesAnteriores >= LIMITE_DESCARTES_SEGUIDOS) return enviar('limite_de_descartes', novas);
  if (e.lockDesde === null || !(e.esperaMaxFilaMs > 0)) return enviar('sem_fila', novas);
  if (e.agora - e.lockDesde > e.esperaMaxFilaMs - MARGEM_FILA_MS) return enviar('turno_longo', novas);
  if (e.inicioUltimoTurno !== null && e.inicioUltimoTurno > e.inicio) return enviar('turno_mais_novo_ja_rodou', novas);

  return { acao: 'descartar', motivo: 'mensagem_nova', novas, humano_no_turno: humano };
}

const ROTULO: Record<TipoMensagem, string> = {
  text: '',
  image_analysis: '[Imagem enviada pelo cliente, descrição automática] ',
  audio_transcription: '[Áudio do cliente, transcrição automática] ',
};

/**
 * Junta o texto do turno descartado ao deste turno, na ordem em que o cliente
 * escreveu. Tipos iguais: junta como o n8n junta o buffer. Tipos diferentes: cada
 * parte leva o seu rótulo e o turno vira `text`, para o prefixo de áudio ou imagem
 * não cobrir o que o cliente digitou.
 */
export function juntarComPendente(
  pendente: Pendente | null,
  atual: { texto: string; tipo: TipoMensagem },
  agora: number,
): { texto: string; tipo: TipoMensagem; juntou: boolean; descartes: number } {
  if (!pendente || !pendente.texto?.trim() || agora - pendente.em > PENDENTE_VALIDADE_MS) {
    return { ...atual, juntou: false, descartes: 0 };
  }
  const descartes = Number.isFinite(pendente.descartes) ? pendente.descartes : 1;
  if (pendente.tipo === atual.tipo) {
    return { texto: `${pendente.texto}\n${atual.texto}`, tipo: atual.tipo, juntou: true, descartes };
  }
  return {
    texto: `${ROTULO[pendente.tipo] ?? ''}${pendente.texto}\n${ROTULO[atual.tipo] ?? ''}${atual.texto}`,
    tipo: 'text',
    juntou: true,
    descartes,
  };
}
