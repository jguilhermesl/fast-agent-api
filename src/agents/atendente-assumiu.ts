// Segura a resposta da IA quando a atendente acabou de assumir a conversa.
//
// O AGENTE BASE do n8n confere `handled_by` depois do LLM (`Filtro_Inicial2`) e
// só então manda as mensagens, uma a uma, pelo /api/send-external. Se a atendente
// escreve nesse meio tempo, o eco do celular passa o lead para `human`, mas a
// resposta da IA já estava a caminho e sai por cima dela. Medido em 08/10/2026
// (Duda, 14 dias): 3 conversas com a IA falando 0,3 a 4 s depois da atendente
// (ex.: 08/10 13:47:20 atendente, 13:47:24 IA).
//
// Só vale para quem pede (header `x-segurar-se-atendente: true`): o nó "[API] Send
// external message" do AGENTE BASE, o envio do FOLLOW UP, os textos fixos do n8n e o
// `enviar_arquivo`. O aviso de transferência para o número da equipe não pede.
//
// A transferência da própria IA ("Um momento, vou passar para a equipe") continua
// saindo: o lead já está em `human`, mas nenhuma atendente escreveu ainda.

import type { EstadoDoLead, MensagemDaConversa } from './rajada';

/** Fala da atendente mais velha que isto não segura mais a IA. */
export const JANELA_ATENDENTE_MS = 120_000;

const TIPOS_DE_FALA = new Set(['text', 'audio', 'image', 'document', 'video']);
const NAO_ATENDENTE = new Set(['AI', 'system']);

/** Mensagem que a equipe mandou (celular ou painel). A IA grava sem `sender_name` ou com "AI". */
export function ehFalaDaAtendente(m: MensagemDaConversa): boolean {
  if (m.direction !== 'outbound') return false;
  if (!m.sender_name || NAO_ATENDENTE.has(m.sender_name)) return false;
  return TIPOS_DE_FALA.has(m.message_type ?? '');
}

/**
 * Turno que já começa com a conversa na equipe. O n8n confere `handled_by` quando a
 * mensagem chega e só de novo depois do LLM; no meio há a espera do buffer (15 s na
 * Duda). Se a IA transfere ou a atendente assume nessa espera, o turno rodava inteiro
 * (gasto e ferramenta com efeito, como o `encerrar_conversa` de 08/10 14:06:49) para
 * o `Filtro_Inicial2` barrar no fim. Aqui o turno nem começa.
 */
export function turnoComecaComAtendente(lead: EstadoDoLead | null): boolean {
  return lead?.handled_by === 'human';
}

/** Até onde olhar para trás procurando a fala do cliente que deu origem ao turno. */
export const JANELA_TURNO_MS = 24 * 3600_000;

/**
 * A equipe já respondeu a última fala do cliente: a IA não fala, seja qual for o
 * `handled_by`. `atendenteAssumiu` exige o lead em `human`, e isso falha quando o
 * eco do celular demora, cai em outra conversa ou ainda não foi gravado. Caso real
 * de 14/10/2026 (Duda, 558182716801): a cliente escreveu 17:09:30, a atendente
 * respondeu 17:09:51 e a IA falou 17:09:56, porque o eco veio com LID e foi para
 * uma conversa fantasma; o lead real seguia em `ai`.
 *
 * Vale para resposta do turno, texto fixo, arquivo e follow-up: em todos, mensagem
 * da equipe depois da última do cliente quer dizer que a equipe está atendendo.
 */
export function equipeFalouDepoisDoCliente(msgs: MensagemDaConversa[], agora: number): boolean {
  let desde = agora - JANELA_TURNO_MS;
  for (const m of msgs) {
    if (m.direction !== 'inbound') continue;
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t) && t > desde) desde = t;
  }
  return msgs.some((m) => {
    if (!ehFalaDaAtendente(m)) return false;
    const t = Date.parse(m.created_at);
    return Number.isFinite(t) && t > desde;
  });
}

export function atendenteAssumiu(
  lead: EstadoDoLead | null,
  msgs: MensagemDaConversa[],
  agora: number,
): boolean {
  if (lead?.handled_by !== 'human') return false;
  const desde = agora - JANELA_ATENDENTE_MS;
  return msgs.some((m) => {
    if (!ehFalaDaAtendente(m)) return false;
    const t = Date.parse(m.created_at);
    return Number.isFinite(t) && t > desde;
  });
}
