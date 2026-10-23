// Estilo do agente aplicado no código, depois que o modelo responde
// (`agents.prompt_config.estilo: { "emoji": false, "dividir": true }`).
//
// Pedir "não use emoji" no prompt não é garantia: o modelo escorrega. No GPT Maker as
// chaves `enabledEmoji` e `splitMessages` são aplicadas na saída e dão 0% de emoji
// quando desligadas. Aqui é o mesmo: o texto final passa por esta função antes de ir
// ao Redis e ao cliente, então o histórico fica igual ao que o cliente recebeu.
//
// Regras (a chave `estilo` ausente = nada muda, byte a byte):
//   - negrito: com a chave presente (qualquer valor), `**texto**` vira `*texto*`, o
//     negrito do WhatsApp. `*texto*` simples não é tocado.
//   - emoji === false: tira emoji (Extended_Pictographic, variação FE0F, ZWJ, tom de
//     pele, bandeira, keycap), arruma o espaço que sobrou e some com a mensagem que só
//     tinha emoji. Keycap numérico deixa o número ("1. item" no começo da linha).
//     Se TODAS as mensagens de texto sumirem, devolve as originais.
//     `emoji: true` ou ausente não mexe. Símbolos fora do Extended_Pictographic (✓ ★ →)
//     ficam; © ® ™ só saem em forma de emoji (com FE0F).
//   - dividir === true: parágrafo separado por linha em branco vira balão próprio, com
//     teto de 4 balões de texto por turno (o excedente cola no último, com linha em
//     branco). dividir === false: texto seguido vira uma mensagem só, com linha em
//     branco entre as partes. Ausente: nem divide nem junta.
//   - mensagem `[[midia:<url>]]` nunca é dividida nem colada em texto, e a ordem entre
//     mídia e texto é mantida: "juntar" e o teto agem só em texto seguido (sem mídia
//     no meio). Por isso, com mídia entre os textos, o turno pode passar de 4 balões.
//   - URLs (e `[[midia:...]]` dentro de texto) não são tocadas.
//
// Função pura, sem `config`: testável sem as env vars do servidor (ver saida.ts).
import { lerMarcador } from './midia-no-fluxo';

export interface EstiloConfig {
  emoji?: boolean;
  dividir?: boolean;
}

export interface MudancasEstilo {
  emojisRemovidos: number;
  baloesAntes: number;
  baloesDepois: number;
  negritoConvertido: number;
  /** Só emoji nas mensagens de texto: ficaram as originais (a resposta não pode sumir). */
  restaurouOriginais?: boolean;
}

/** Máximo de balões de texto por turno quando `dividir: true`. */
export const MAX_BALOES = 4;

/**
 * `prompt_config.estilo` (ou o `estilo` do corpo) → configuração válida.
 * Só objeto vale; qualquer outra coisa (ausente, null, string, array) = sem estilo.
 * Campo que não é booleano é ignorado.
 */
export function lerEstilo(valor: unknown): EstiloConfig | undefined {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return undefined;
  const v = valor as Record<string, unknown>;
  return {
    ...(typeof v.emoji === 'boolean' ? { emoji: v.emoji } : {}),
    ...(typeof v.dividir === 'boolean' ? { dividir: v.dividir } : {}),
  };
}

// ── Trechos que não se tocam ──────────────────────────────────

// URL vai até o espaço, mas sem engolir um emoji colado nela ("https://x.com" + emoji sem espaço).
const PROTEGIDO = /\[\[midia:[^\]\s]*\]\]|(?:https?:\/\/|www\.)[^\s\p{Extended_Pictographic}\uFE0F\u200D]+/giu;
const PH_ABRE = '\uE000';
const PH_FECHA = '\uE001';

/** Quantos caracteres do fim da URL são pontuação da frase (ou `*` do negrito), não da URL. */
function pontaDaUrl(url: string): number {
  let fim = url.length;
  while (fim > 0) {
    const c = url[fim - 1];
    if (/[.,;:!?*"'”»\]]/.test(c)) fim--;
    // `)` só sai se a URL não abriu parêntese (Wikipedia: .../Foo_(bar)).
    else if (c === ')' && url.slice(0, fim).split('(').length < url.slice(0, fim).split(')').length) fim--;
    else break;
  }
  return url.length - fim;
}

function protegerTrechos(texto: string): { texto: string; guardados: string[] } {
  const guardados: string[] = [];
  const out = texto.replace(PROTEGIDO, (m) => {
    const ponta = m.startsWith('[[') ? 0 : pontaDaUrl(m);
    const nucleo = m.slice(0, m.length - ponta);
    if (!nucleo) return m;
    guardados.push(nucleo);
    return `${PH_ABRE}${guardados.length - 1}${PH_FECHA}${m.slice(m.length - ponta)}`;
  });
  return { texto: out, guardados };
}

function restaurarTrechos(texto: string, guardados: string[]): string {
  if (guardados.length === 0) return texto;
  return texto.replace(new RegExp(`${PH_ABRE}(\\d+)${PH_FECHA}`, 'g'), (_, i: string) => guardados[Number(i)] ?? '');
}

// ── Emoji ─────────────────────────────────────────────────────

const MODIFICADORES = '[\\uFE0F\\p{Emoji_Modifier}]*';
const EMOJI = new RegExp(
  [
    // keycap: digito, # ou * + FE0F opcional + U+20E3
    '[0-9#*]\\uFE0F?\\u20E3',
    // bandeira = dois indicadores regionais
    '\\p{Regional_Indicator}{1,2}',
    // pictograma (+ tom de pele/FE0F), emendado por ZWJ, com tags de bandeira de região no fim.
    // © ® ™ sozinhos são texto; só valem como emoji com FE0F.
    `(?:[\\u00A9\\u00AE\\u2122]\\uFE0F|(?![\\u00A9\\u00AE\\u2122])\\p{Extended_Pictographic})${MODIFICADORES}` +
      `(?:\\u200D\\p{Extended_Pictographic}${MODIFICADORES})*[\\u{E0020}-\\u{E007F}]*`,
  ].join('|'),
  'gu',
);
/** Pedaços de emoji que ficaram soltos (FE0F, ZWJ, keycap, tag, tom de pele) */
const RESTOS_DE_EMOJI = /[\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}\p{Emoji_Modifier}]/gu;
const SENTINELA = '\u0001';

const PONTUACAO_DEPOIS = /[,.;:!?)\]…]/;
const LETRA_OU_NUMERO = /[\p{L}\p{N}]/u;

/** O que vem antes de `idx` é marcador de abertura ("**", "(", aspas) colado ao emoji? */
function abreFormatacao(s: string, idx: number): boolean {
  let i = idx - 1;
  let n = 0;
  while (i >= 0 && /[*_~(["'“«]/.test(s[i])) {
    i--;
    n++;
  }
  return n > 0 && (i < 0 || /\s/.test(s[i]));
}

/** A partir de `pos` há marcador de fechamento ("**", "_") e não uma palavra? */
function fechaFormatacao(s: string, pos: number): boolean {
  let i = pos;
  while (i < s.length && /[*_~]/.test(s[i])) i++;
  return i > pos && (i >= s.length || !LETRA_OU_NUMERO.test(s[i]));
}

/** Decide o que fica no lugar do emoji, olhando só os vizinhos dele. */
function resolverSentinelas(texto: string): string {
  const junto = texto.replace(new RegExp(`${SENTINELA}(?:[ \\t]*${SENTINELA})*`, 'g'), SENTINELA);
  return junto.replace(new RegExp(`([ \\t]*)${SENTINELA}([ \\t]*)`, 'g'), (m, antes: string, depois: string, i: number, s: string) => {
    const prev = i > 0 ? s[i - 1] : '';
    const next = s[i + m.length] ?? '';
    const inicioLinha = prev === '' || prev === '\n';
    const fimLinha = next === '' || next === '\n';
    if (inicioLinha) return fimLinha ? '' : antes; // linha só de emoji some; senão fica o recuo
    if (fimLinha) return '';
    if (PONTUACAO_DEPOIS.test(next)) return '';
    if (antes === '' && abreFormatacao(s, i)) return '';
    if (depois === '' && fechaFormatacao(s, i + m.length)) return '';
    if (antes || depois) return ' ';
    return LETRA_OU_NUMERO.test(prev) && LETRA_OU_NUMERO.test(next) ? ' ' : '';
  });
}

// O keycap numerico (digito + FE0F + U+20E3) numera menu e lista: o numero e informacao, entao
// fica (no comeco da linha, como "1."). So o enfeite sai; keycap de # e * sai como qualquer emoji.
const KEYCAP_NO_INICIO = /(^|\n)([ \t]*)([0-9])\uFE0F?\u20E3/g;
const KEYCAP_NO_MEIO = /([0-9])\uFE0F?\u20E3/g;

function tirarEmoji(texto: string): { texto: string; removidos: number } {
  let removidos = 0;
  const comNumeros = texto
    .replace(KEYCAP_NO_INICIO, (_, quebra: string, recuo: string, digito: string) => {
      removidos++;
      return `${quebra}${recuo}${digito}.`;
    })
    .replace(KEYCAP_NO_MEIO, (_, digito: string) => {
      removidos++;
      return digito;
    });
  const marcado = comNumeros.replace(EMOJI, () => {
    removidos++;
    return SENTINELA;
  });
  const semResto = marcado.replace(RESTOS_DE_EMOJI, '');
  if (removidos === 0) return { texto: semResto, removidos };
  const limpo = resolverSentinelas(semResto).replace(/\n{3,}/g, '\n\n').trim();
  return { texto: limpo, removidos };
}

// ── Negrito ───────────────────────────────────────────────────

// `**texto**` (sem espaço colado por dentro, numa linha só, sem `***`) → `*texto*`.
const NEGRITO = /(?<!\*)\*\*(?!\*)([^\s*](?:[^*\n]*[^\s*])?)\*\*(?!\*)/g;

function converterNegrito(texto: string): { texto: string; convertidos: number } {
  let convertidos = 0;
  const out = texto.replace(NEGRITO, (_, miolo: string) => {
    convertidos++;
    return `*${miolo}*`;
  });
  return { texto: out, convertidos };
}

// ── Balões ────────────────────────────────────────────────────

/** Duas ou mais quebras de linha seguidas (a linha em branco pode ter espaço). */
const LINHA_EM_BRANCO = /(?:\r?\n[ \t]*){2,}/;

function paragrafos(texto: string): string[] {
  if (!LINHA_EM_BRANCO.test(texto)) return [texto];
  return texto
    .split(LINHA_EM_BRANCO)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

export function aplicarEstilo(
  mensagens: string[],
  estilo?: EstiloConfig | null,
): { mensagens: string[]; mudancas: MudancasEstilo } {
  const baloesAntes = mensagens.length;
  if (!estilo) {
    return { mensagens, mudancas: { emojisRemovidos: 0, baloesAntes, baloesDepois: baloesAntes, negritoConvertido: 0 } };
  }

  let emojisRemovidos = 0;
  let negritoConvertido = 0;
  let textosAntes = 0;
  let textosDepois = 0;

  // Dividir: 4 balões de texto. Juntar: 1 (por trecho de texto seguido, a mídia corta).
  const teto = estilo.dividir === true ? MAX_BALOES : estilo.dividir === false ? 1 : Infinity;
  const saida: string[] = [];
  let baloesDeTexto = 0;
  let ultimoEhTexto = false;

  const emitirTexto = (t: string) => {
    if (ultimoEhTexto && baloesDeTexto >= teto) {
      saida[saida.length - 1] += `\n\n${t}`;
    } else {
      saida.push(t);
      baloesDeTexto++;
    }
    ultimoEhTexto = true;
  };

  for (const original of mensagens) {
    if (lerMarcador(original) !== null) {
      saida.push(original);
      ultimoEhTexto = false;
      continue;
    }
    if (original.trim() !== '') textosAntes++;

    const { texto: protegido, guardados } = protegerTrechos(original);
    let t = protegido;
    if (estilo.emoji === false) {
      const r = tirarEmoji(t);
      t = r.texto;
      emojisRemovidos += r.removidos;
    }
    const neg = converterNegrito(t);
    t = restaurarTrechos(neg.texto, guardados);
    negritoConvertido += neg.convertidos;

    if (t.trim() === '') continue; // só tinha emoji
    textosDepois++;
    for (const parte of estilo.dividir === true ? paragrafos(t) : [t]) emitirTexto(parte);
  }

  // Resposta que era só emoji: melhor o emoji do que o cliente ficar sem resposta.
  if (textosAntes > 0 && textosDepois === 0) {
    return {
      mensagens,
      mudancas: { emojisRemovidos: 0, baloesAntes, baloesDepois: baloesAntes, negritoConvertido: 0, restaurouOriginais: true },
    };
  }

  return { mensagens: saida, mudancas: { emojisRemovidos, baloesAntes, baloesDepois: saida.length, negritoConvertido } };
}
