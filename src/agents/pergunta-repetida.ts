/**
 * Pergunta repetida (`prompt_config.nao_repetir_pergunta: true`, 29/10/2026).
 *
 * Reclamação do dono da Costa & Muniz: "ela tenta insistir muito numa pergunta". Na Canda
 * (gpt-5.4), em teste:
 *   Canda: "Pensa em fechar pra quando?"                                   cliente: "Investir"
 *   Canda: "Esse perfil costuma ir bem pra renda e valorização em Manaíra. Pensa em fechar pra quando?"
 *                                                                          cliente: "Moro em Recife"
 *   Canda: "Então você vai comprar de fora. Pensa em fechar pra quando?"
 * e "Em qual região você pensa?" três vezes em outra conversa. A regra já estava no prompt; o modelo
 * ignora. Aqui a trava é no código: o orquestrador refaz a resposta UMA vez com a correção.
 *
 * Regra (só texto, sem LLM):
 *  - Pergunta = trecho que termina em "?" (o que vem depois do último ".", "!", "?" ou quebra de linha).
 *  - Compara com as perguntas das últimas 4 falas da agente no histórico (cada fala = um turno).
 *  - Normaliza: minúscula, sem acento, sem pontuação. Palavras significativas = sem as vazias
 *    ("de", "pra", "você", "o"...), com 2+ letras, cortadas nas 5 primeiras letras ("pensando" = "pensa").
 *  - Repetida quando: texto normalizado igual (com 2+ palavras significativas), OU Jaccard das
 *    palavras significativas ≥ 0,7, OU todas as palavras da pergunta mais curta (3+ palavras)
 *    estão na outra.
 *  - Não conta:
 *    · pergunta com menos de 2 palavras significativas ("Tudo bem?", "Pode ser?");
 *    · resposta nova com link que a fala anterior não tinha (ficha de imóvel nova: "É esse imóvel
 *      que te atende?" depois de outro imóvel pergunta sobre outra coisa);
 *    · cliente pediu para repetir ("não entendi", "como assim?", "pode repetir?").
 */

export const FALAS_OLHADAS = 4;
export const JACCARD_MINIMO = 0.7;

export interface FalaDoHistorico {
  role: 'user' | 'assistant';
  content: string;
}

export interface PerguntaRepetida {
  /** A pergunta da resposta nova, como o modelo escreveu. */
  pergunta: string;
  /** A pergunta que já tinha sido feita, como estava no histórico. */
  anterior: string;
  /** Texto para o modelo refazer a resposta. */
  correcao: string;
}

const VAZIAS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos',
  'nas', 'pra', 'pro', 'pras', 'pros', 'para', 'por', 'pelo', 'pela', 'com', 'e', 'ou', 'que', 'se', 'me',
  'te', 'lhe', 'voce', 'vc', 'voces', 'seu', 'sua', 'seus', 'suas', 'eu', 'ja', 'ai', 'entao', 'mas', 'tambem',
  'isso', 'esse', 'essa', 'este', 'esta', 'ne', 'tudo', 'bem', 'certo', 'ok', 'pode', 'ser', 'ta',
]);

/** Fala do cliente (minúscula, sem acento) pedindo para repetir: aí a pergunta pode voltar. */
const PEDIU_PARA_REPETIR = /nao entendi|como assim|pode repetir|\brepete\b|\brepita\b|^\s*oi\s*\?+\s*$/;

export function normalizarPergunta(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Raiz grosseira (5 primeiras letras): "pensa" e "pensando", "compra" e "comprar" viram a mesma. */
function palavras(normalizada: string): Set<string> {
  return new Set(normalizada.split(' ').filter((p) => p.length >= 2 && !VAZIAS.has(p)).map((p) => p.slice(0, 5)));
}

/** Trechos que terminam em "?", sem o que vem antes do último ".", "!", "?" ou quebra de linha. */
export function extrairPerguntas(texto: string): string[] {
  return (texto.match(/[^.!?\n]*\?+/g) ?? []).map((p) => p.trim()).filter((p) => p.length > 1);
}

export function mesmaPergunta(a: string, b: string): boolean {
  const na = normalizarPergunta(a);
  const nb = normalizarPergunta(b);
  const pa = palavras(na);
  const pb = palavras(nb);
  if (pa.size < 2 || pb.size < 2) return false;
  if (na === nb) return true;
  let comuns = 0;
  for (const p of pa) if (pb.has(p)) comuns++;
  const uniao = pa.size + pb.size - comuns;
  if (comuns / uniao >= JACCARD_MINIMO) return true;
  const menor = Math.min(pa.size, pb.size);
  return menor >= 3 && comuns === menor;
}

const links = (s: string) => new Set(s.match(/https?:\/\/\S+|\/imovel\/[\w-]+/gi) ?? []);

export function correcaoDePergunta(pergunta: string, jaFeitas: string[] = []): string {
  // Teste de 29/10: com só a pergunta repetida, o modelo trocava por outra que também já tinha feito.
  const outras = jaFeitas.filter((p) => p !== pergunta);
  return (
    `[Instrução interna, não é do cliente: você já perguntou "${pergunta}" e o cliente respondeu outra coisa. ` +
    'Não repita essa pergunta, nem com outras palavras' +
    (outras.length ? `, nem estas que você também já fez: ${outras.map((p) => `"${p}"`).join('; ')}` : '') +
    '. Aproveite o que ele disse, avance com uma pergunta nova ou mostre opções; se não houver pergunta nova a ' +
    'fazer, responda sem pergunta. Reescreva a resposta no mesmo formato de saída.]'
  );
}

/**
 * Último recurso quando a reescrita insiste: tira das mensagens as frases-pergunta que repetem uma já feita.
 * Mensagem que fica vazia sai da lista; se todas ficariam vazias, devolve as originais (melhor repetir que calar).
 */
export function tirarPerguntasRepetidas(mensagens: string[], historico: FalaDoHistorico[]): string[] {
  const feitas = historico
    .filter((m) => m.role === 'assistant')
    .slice(-FALAS_OLHADAS)
    .flatMap((f) => extrairPerguntas(f.content));
  const limpas = mensagens
    .map((m) => {
      let t = m;
      for (const p of extrairPerguntas(m)) if (feitas.some((f) => mesmaPergunta(p, f))) t = t.replace(p, '');
      return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    })
    .filter((m) => m.length > 0);
  return limpas.length ? limpas : mensagens;
}

/**
 * `resposta`: o texto que vai sair (mensagens do turno juntas). `historico`: a conversa antes deste
 * turno, a mais antiga primeiro. `mensagemCliente`: a fala do cliente neste turno.
 */
export function detectarPerguntaRepetida(
  resposta: string,
  historico: FalaDoHistorico[],
  mensagemCliente = '',
): PerguntaRepetida | null {
  const novas = extrairPerguntas(resposta);
  if (!novas.length) return null;
  const cliente = mensagemCliente.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (PEDIU_PARA_REPETIR.test(cliente)) return null;

  const falas = historico.filter((m) => m.role === 'assistant').slice(-FALAS_OLHADAS);
  const linksNovos = links(resposta);
  for (const fala of falas.reverse()) {
    const linksDaFala = links(fala.content);
    const fichaNova = [...linksNovos].some((l) => !linksDaFala.has(l));
    if (fichaNova) continue;
    for (const anterior of extrairPerguntas(fala.content)) {
      const pergunta = novas.find((n) => mesmaPergunta(n, anterior));
      if (pergunta) {
        const jaFeitas = falas.flatMap((f) => extrairPerguntas(f.content));
        return { pergunta, anterior, correcao: correcaoDePergunta(anterior, jaFeitas) };
      }
    }
  }
  return null;
}
