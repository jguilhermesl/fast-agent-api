// Segura a resposta da IA quando a atendente acabou de assumir a conversa.
//
// O AGENTE BASE do n8n confere `handled_by` depois do LLM (`Filtro_Inicial2`) e
// só então manda as mensagens, uma a uma, pelo /api/send-external. Se a atendente
// escreve nesse meio tempo, o eco do celular passa o lead para `human`, mas a
// resposta da IA já estava a caminho e sai por cima dela. Medido em 08/10/2026
// (Duda, 14 dias): 3 conversas com a IA falando 0,3 a 4 s depois da atendente
// (ex.: 08/10 13:47:20 atendente, 13:47:24 IA).
//
// Só vale para quem pede (header `x-segurar-se-atendente: true`, mandado pelo nó
// "[API] Send external message" do AGENTE BASE). O /api/send-external também leva
// aviso de transferência para o número da equipe, texto fixo e follow-up: esses
// não passam por aqui.
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
