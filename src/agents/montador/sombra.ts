// Montador único, passo 3: compara o prompt que o código montou com o `system_prompt` que o n8n mandou.
// Funções puras. Nada aqui consulta banco nem grava.

export interface ComparacaoMontador {
  /** Idênticos, byte a byte. */
  igual: boolean;
  /** Idênticos depois de trocar só o valor da linha "Horário:" de `<dados_usuario>` (único dado legitimamente dinâmico do turno). */
  igualSemHorario: boolean;
  tamanhoMontado: number;
  tamanhoRecebido: number;
  /** Posição (UTF-16) da primeira diferença que não seja o horário; se só o horário difere, a posição dele. `null` = iguais. */
  primeiraDiferenca: number | null;
  /** Até 120 caracteres do prompt montado em volta da primeira diferença, com dados de cliente mascarados. */
  trechoMontado: string;
  /** Idem, do prompt que o n8n mandou. */
  trechoRecebido: string;
}

export type VereditoMontador = 'montador_igual' | 'montador_igual_sem_horario' | 'montador_diferente';

export const TRECHO_MAXIMO = 120;
const ANTES_DA_DIFERENCA = 40;
const MARCA_HORARIO = '<HORARIO>';

export function vereditoDe(c: ComparacaoMontador): VereditoMontador {
  if (c.igual) return 'montador_igual';
  return c.igualSemHorario ? 'montador_igual_sem_horario' : 'montador_diferente';
}

// ── Horário ───────────────────────────────────────────────────

const RE_HORARIO =
  /(\n<dados_usuario>\nNome:[^\n]*\nTelefone:[^\n]*\nHorário: )([^\n]*)( \(horário de Brasília\)\n<\/dados_usuario>)/g;

interface SemHorario {
  texto: string;
  /** Onde o valor do horário começava e quanto media; `null` = bloco não encontrado, nada foi trocado. */
  valor: { inicio: number; tamanho: number } | null;
}

/** Troca o valor da linha "Horário:" do ÚLTIMO bloco `<dados_usuario>` (persona ou base podem citar o nome da tag). */
function tirarHorario(prompt: string): SemHorario {
  let ultimo: RegExpMatchArray | null = null;
  for (const m of prompt.matchAll(RE_HORARIO)) ultimo = m;
  if (!ultimo || ultimo.index === undefined) return { texto: prompt, valor: null };
  const inicio = ultimo.index + ultimo[1].length;
  return {
    texto: prompt.slice(0, inicio) + MARCA_HORARIO + prompt.slice(inicio + ultimo[2].length),
    valor: { inicio, tamanho: ultimo[2].length },
  };
}

/** Posição no texto original de uma posição do texto com o horário trocado. */
function posicaoOriginal(posNormalizada: number, s: SemHorario): number {
  if (!s.valor || posNormalizada < s.valor.inicio) return posNormalizada;
  const fimMarca = s.valor.inicio + MARCA_HORARIO.length;
  if (posNormalizada < fimMarca) return s.valor.inicio;
  return posNormalizada - MARCA_HORARIO.length + s.valor.tamanho;
}

// ── Máscara (mantém o tamanho, para as posições continuarem valendo) ──────────────────────────

/** Letra vira x/X, dígito vira 9, o resto fica. Cada code point vira o mesmo número de unidades UTF-16. */
function formaDoTexto(s: string): string {
  return s.replace(/[\p{L}\p{N}]/gu, (c) => {
    const novo = /\p{N}/u.test(c) ? '9' : c === c.toLowerCase() ? 'x' : 'X';
    return novo.repeat(c.length);
  });
}

/**
 * Esconde dado de cliente final do trecho que vai para o log: a forma (tamanho, caixa, pontuação)
 * continua visível, o conteúdo não. Cobre o nome do contato, as intenções executadas e o início da
 * conversa; em qualquer lugar, sequência de 10 ou mais dígitos (telefone, CPF, CNPJ) vira `*`.
 */
export function mascararDadosDeCliente(prompt: string): string {
  let t = prompt;
  t = t.replace(/(<dados_usuario>\nNome: )([^\n]*)/g, (_m, a: string, nome: string) => a + formaDoTexto(nome));
  t = t.replace(/(<intents_executadas>\n)([\s\S]*?)(\n<\/intents_executadas>)/g, (_m, a: string, corpo: string, z: string) => a + formaDoTexto(corpo) + z);
  t = t.replace(/(<inicio_da_conversa>\n[^\n]*\n)([\s\S]*?)(\n<\/inicio_da_conversa>)/g, (_m, a: string, corpo: string, z: string) => a + formaDoTexto(corpo) + z);
  t = t.replace(/\+?\d(?:[ ().-]{0,2}\d){9,}/g, (seq) => seq.replace(/\d/g, '*'));
  return t;
}

function trechoEm(textoMascarado: string, pos: number): string {
  const inicio = Math.max(0, pos - ANTES_DA_DIFERENCA);
  let t = textoMascarado.slice(inicio, inicio + TRECHO_MAXIMO);
  // não deixa meio caractere (par substituto cortado) nas pontas
  if (t.length > 0 && /[\uDC00-\uDFFF]/.test(t[0])) t = t.slice(1);
  if (t.length > 0 && /[\uD800-\uDBFF]/.test(t[t.length - 1])) t = t.slice(0, -1);
  return t;
}

function primeiroIndiceDiferente(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// ── API ───────────────────────────────────────────────────────

export function compararComN8n(montado: string, recebido: string): ComparacaoMontador {
  const base = { tamanhoMontado: montado.length, tamanhoRecebido: recebido.length };
  if (montado === recebido) {
    return { igual: true, igualSemHorario: true, ...base, primeiraDiferenca: null, trechoMontado: '', trechoRecebido: '' };
  }

  const m = tirarHorario(montado);
  const r = tirarHorario(recebido);
  // os dois precisam ter o bloco: se um não tem, não há o que normalizar e a diferença é real
  const normalizavel = m.valor !== null && r.valor !== null;
  const igualSemHorario = normalizavel && m.texto === r.texto;

  let posMontado: number;
  let posRecebido: number;
  if (igualSemHorario || !normalizavel) {
    posMontado = posRecebido = primeiroIndiceDiferente(montado, recebido);
  } else {
    const i = primeiroIndiceDiferente(m.texto, r.texto);
    posMontado = posicaoOriginal(i, m);
    posRecebido = posicaoOriginal(i, r);
  }

  return {
    igual: false,
    igualSemHorario,
    ...base,
    primeiraDiferenca: posMontado,
    trechoMontado: trechoEm(mascararDadosDeCliente(montado), posMontado),
    trechoRecebido: trechoEm(mascararDadosDeCliente(recebido), posRecebido),
  };
}
