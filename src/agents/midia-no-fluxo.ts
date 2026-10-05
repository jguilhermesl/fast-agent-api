// Mídia no fluxo da conversa (`agents.prompt_config.midia_no_fluxo: true`).
//
// Sem isto, `enviar_arquivo` manda a foto na hora em que o Executor roda, ainda
// dentro do /api/chat; o texto do turno só sai depois, quando o n8n recebe a
// resposta. No WhatsApp a foto chegava antes do cumprimento e da ficha do
// imóvel (Canda, Costa & Muniz, 05/10/2026).
//
// Com a chave ligada, `enviar_arquivo` só registra a foto. Aqui ela vira uma
// mensagem própria (`[[midia:<url>]]`) antes da última mensagem do turno, e o
// n8n manda tudo em ordem pelo /api/send-external, que reconhece o marcador e
// envia como mídia. O n8n não muda.
//
// Função pura, sem `config`: testável sem as env vars do servidor (ver saida.ts).
import type { ToolCallLog } from '../types';

const MARCADOR = /^\s*\[\[midia:(https?:\/\/[^\s\]]+)\]\]\s*$/i;

export function marcadorMidia(url: string): string {
  return `[[midia:${url}]]`;
}

/** URL da mídia se a mensagem inteira for um marcador; senão null. */
export function lerMarcador(content: string): string | null {
  return content.match(MARCADOR)?.[1] ?? null;
}

/**
 * Deduz o `type` que `/api/send-external` espera a partir da extensão do
 * arquivo. `enviar_arquivo` só recebe `file_url` — não tem esse dado pronto.
 */
export function tipoPorExtensao(fileUrl: string): 'image' | 'video' | 'audio' | 'document' {
  const semQuery = fileUrl.split('?')[0].toLowerCase();
  const ext = semQuery.slice(semQuery.lastIndexOf('.') + 1);
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'opus', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'document';
}

/** Mídias que o `enviar_arquivo` deixou para a resposta, na ordem, sem repetir. */
export function midiasAdiadas(tools: ToolCallLog[]): string[] {
  const urls: string[] = [];
  for (const t of tools) {
    if (t.tool !== 'enviar_arquivo') continue;
    const r = t.result as { status?: unknown; data?: { adiado?: unknown } } | null;
    const url = t.arguments?.file_url;
    if (r?.status !== 'ok' || r.data?.adiado !== true || typeof url !== 'string') continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Põe as mídias antes da última mensagem: "Show! Separei umas fotos" → fotos →
 * ficha com a pergunta.
 *
 * Mensagem única com parágrafos (o modelo junta acolhida e ficha, visto em
 * 05/10 com `response_style: conciso`): divide no primeiro parágrafo e as fotos
 * entram entre ele e o resto. Mensagem única sem parágrafo: fotos depois dela.
 * Sem nenhuma mensagem, saem só as fotos.
 */
export function intercalarMidias(mensagens: string[], urls: string[]): string[] {
  if (urls.length === 0) return mensagens;
  const midias = urls.map(marcadorMidia);
  if (mensagens.length === 0) return midias;
  if (mensagens.length === 1) {
    const [primeiro, ...resto] = mensagens[0].split(/\n\s*\n/);
    const depois = resto.join('\n\n').trim();
    return depois ? [primeiro.trim(), ...midias, depois] : [mensagens[0], ...midias];
  }
  return [...mensagens.slice(0, -1), ...midias, mensagens[mensagens.length - 1]];
}

/**
 * Texto do turno para o histórico do Redis. O marcador vira "[Imagem]", o mesmo
 * prefixo que o /api/send-external gravava quando a foto saía pelo loopback:
 * o modelo vê que mandou foto sem ver a URL (e sem copiá-la num texto depois).
 */
export function paraHistorico(mensagens: string[]): string {
  const rotulo = { image: '[Imagem]', video: '[Vídeo]', audio: '[Áudio]', document: '[Documento]' } as const;
  return mensagens
    .map((m) => {
      const url = lerMarcador(m);
      return url ? rotulo[tipoPorExtensao(url)] : m;
    })
    .join('\n');
}
