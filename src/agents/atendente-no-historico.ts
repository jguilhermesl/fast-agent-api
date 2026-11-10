/**
 * O Orquestrador não enxerga o que a equipe escreve.
 *
 * O histórico vem do Redis e só tem cliente × IA. Mensagem que o atendente manda pelo
 * celular (ou pelo painel) fica em `messages`, nunca no histórico. Quando a conversa
 * volta para a IA, ela responde como se o atendente não tivesse falado nada.
 *
 * Caso real (Leandro/Quiroleve, 10/11/2026, lead dc8ce310): a IA tinha parado em 31/10
 * pedindo o nome para marcar "terça, 03/11 às 11h". O dono marcou a consulta à mão e,
 * em 10/11 09:33, mandou pelo celular "Hoje temos um horário às 11hs agendado… confirme
 * tua presença". O paciente respondeu "SIM". Uma hora depois a conversa voltou para a
 * IA (`ai-return-cron`), que leu o "SIM" como resposta à pergunta dela de dez dias
 * antes, tentou criar o evento de 03/11 e respondeu "Esse horário de terça, 03/11 em
 * Ibiporã não consigo mais te colocar". Medido na agenda da clínica: 24 de 31 consultas
 * dos 7 dias seguintes eram marcadas à mão, todas com lembrete manual do dono.
 *
 * A nota traz a linha do tempo real (cliente, IA e atendente, com data e hora) e vai só
 * na mensagem do cliente deste turno, nunca no histórico nem no system (não mexe no
 * cache). Só existe quando há fala de atendente nas últimas mensagens. Ligada por agente:
 * `prompt_config.enxerga_atendente === true`.
 */

import { ehFalaDaAtendente } from './atendente-assumiu';
import type { MensagemDaConversa } from './rajada';

/** Até onde olhar para trás. */
export const JANELA_ATENDENTE_NO_HISTORICO_MS = 14 * 24 * 3600_000;

/** Quantas linhas, no máximo, entram na nota (as mais recentes). */
export const MAX_LINHAS_DA_NOTA = 14;

/** Corte de cada fala dentro da nota. */
export const MAX_CHARS_POR_FALA = 260;

const TIPOS_DE_FALA = new Set(['text', 'audio', 'image', 'document', 'video']);

const NOME_DA_MIDIA: Record<string, string> = {
  audio: 'áudio',
  image: 'imagem',
  video: 'vídeo',
  document: 'documento',
  text: 'mensagem sem texto',
};

const quando = (iso: string): string => {
  const d = new Date(iso);
  const dia = d
    .toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' })
    .replace('.', '');
  const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' });
  return `${dia} ${data} ${hora}`;
};

const umaLinha = (texto: string): string => {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length > MAX_CHARS_POR_FALA ? `${t.slice(0, MAX_CHARS_POR_FALA).trimEnd()}…` : t;
};

interface Linha {
  quem: string;
  atendente: boolean;
  quando: string;
  /** Texto entre aspas, ou null quando é mídia sem texto. */
  texto: string | null;
  midia: string;
  /** Mídias seguidas do mesmo autor viram uma linha só. */
  vezes: number;
}

/**
 * @param msgs mensagens da conversa em ordem crescente de `created_at` (qualquer tipo;
 *   as de sistema são ignoradas aqui).
 * @returns a nota, ou null quando não há fala de atendente nas últimas mensagens.
 */
export function notaDoAtendente(msgs: MensagemDaConversa[], agora: number): string | null {
  const desde = agora - JANELA_ATENDENTE_NO_HISTORICO_MS;
  const falas = msgs.filter((m) => {
    if (!TIPOS_DE_FALA.has(m.message_type ?? '')) return false;
    const t = Date.parse(m.created_at);
    return Number.isFinite(t) && t >= desde && t <= agora;
  });

  // As falas do cliente no fim são o próprio turno: já chegam como mensagem do turno.
  let fim = falas.length;
  while (fim > 0 && falas[fim - 1].direction === 'inbound') fim--;
  const anteriores = falas.slice(0, fim);

  const linhas: Linha[] = [];
  for (const m of anteriores) {
    const atendente = ehFalaDaAtendente(m);
    const quem = m.direction === 'inbound' ? 'cliente' : atendente ? `${m.sender_name} (atendente)` : 'você';
    const texto = (m.content ?? '').trim();
    // "." é o texto do comando de devolver a conversa para a IA, não uma fala.
    if (atendente && texto === '.') continue;
    const midia = NOME_DA_MIDIA[m.message_type ?? ''] ?? 'mídia';
    const ultima = linhas[linhas.length - 1];
    if (!texto && ultima && ultima.texto === null && ultima.quem === quem && ultima.midia === midia) {
      ultima.vezes++;
      continue;
    }
    linhas.push({ quem, atendente, quando: quando(m.created_at), texto: texto ? umaLinha(texto) : null, midia, vezes: 1 });
  }

  const recentes = linhas.slice(-MAX_LINHAS_DA_NOTA);
  if (!recentes.some((l) => l.atendente)) return null;

  const corpo = recentes
    .map((l) => {
      const dito = l.texto !== null ? `"${l.texto}"` : `[${l.midia}${l.vezes > 1 ? ` ×${l.vezes}` : ''}, você não vê o conteúdo]`;
      return `- ${l.quando} · ${l.quem}: ${dito}`;
    })
    .join('\n');

  return (
    '[Nota interna, não é do cliente: nesta conversa o atendente humano também escreveu direto para o cliente. ' +
    'As mensagens dele NÃO aparecem no seu histórico. Linha do tempo real das últimas mensagens (horário de Brasília):\n' +
    `${corpo}\n` +
    'O que o atendente escreveu vale como dito por você: não contradiga, não repita e não refaça pergunta ou oferta ' +
    'que ele já resolveu. Se o cliente está respondendo a uma mensagem do atendente (confirmando presença, ' +
    'agradecendo, avisando que vai), responda só a isso, em uma frase curta: não inicie agendamento, cobrança nem ' +
    'consulta de agenda por causa dessa resposta. Compromisso que o atendente confirmou já está marcado por ele. ' +
    'Se a resposta do cliente depender de um áudio ou imagem que você não vê, não invente: responda curto e neutro.]'
  );
}
