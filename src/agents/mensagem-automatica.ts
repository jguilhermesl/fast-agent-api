/**
 * A mensagem do contato tem cara de robô de empresa (cobrança, banco, resposta automática,
 * menu)? Usado só para aceitar o silêncio do modelo (agents/saida.ts): a persona da Duda manda
 * não responder robô, e o vazio virava "instabilidade" + transferência (04–05/11/2026, 4 casos:
 * Bradesco, cartão ELO, "Kit Festa"). Precisa de 2 sinais, ou 1 sinal forte, para não calar
 * paciente que só cita banco ou "mensagem automática".
 *
 * 09 e 11/11/2026: mais 2 casos que escaparam. Mensagem de ausência de conta comercial ("não
 * estamos disponíveis para atendimento... nosso horário de atendimento é...") e convite de
 * aplicativo ("Convide amigos para entrar no TikTok Lite usando seu código e ganhe recompensas").
 *
 * 17/11/2026 (card #1223): menu de opções de empresa. Em 28/10 a Duda respondeu 17 vezes ao
 * atendimento automático da B4 Telecom ("Seja bem-vindo a central de atendimento...", "Opção não
 * encontrada, por favor, escolha uma das opções do menu (Digite somente o número da opção)").
 * Nenhuma dessas frases era reconhecida aqui. Desde então a função também decide a pausa antes
 * do LLM quando as duas últimas mensagens recebidas são automáticas (agents/loop-robo.ts,
 * `decidirRoboNoRabo`): uma mensagem só nunca cala a IA, porque paciente encaminha mensagem
 * automática para perguntar sobre ela.
 */
// Pesquisa de satisfação. Tem de citar o atendimento: paciente pergunta "Como você avalia esses
// resultados?\n1 - Glicose: 180\n2 - Colesterol: 240" (5ª revisão do Codex, 17/11/2026).
const COMO_AVALIA_O_ATENDIMENTO = /\bcomo\s+voc[eê]\s+avalia\s+(o\s+|a\s+)?(meu\s+|minha\s+|noss[oa]\s+|este\s+|esse\s+|esta\s+|essa\s+)?(atendimento|servi[cç]o|suporte|experi[eê]ncia)\b/i;

const FORTES = [
  /resposta autom[aá]tica\*?\s*\n/i,
  /^\s*\*?resposta autom[aá]tica/i,
  /para n[aã]o receber (novas|mais) mensagens/i,
  /selecione\s+(a op[cç][aã]o|parar)/i,
  /digite\s+\d+\s+para/i,
  /caso (j[aá] )?tenha (realizado|efetuado) o pagamento,?\s*desconsidere/i,
  // Ausência de conta comercial: quem fala "nós" sobre o próprio atendimento é empresa, não paciente.
  /no momento,? n[aã]o estamos (mais )?dispon[ií]ve(l|is)/i,
  /n[aã]o estamos (mais )?dispon[ií]ve(l|is) (no momento|(para|pra) (o )?atend)/i,
  /nosso hor[aá]rio de (atendimento|funcionamento) [eé]\s/i,
  // Menu de opções: só robô manda escolher opção pelo número ou avisa que a opção não existe.
  /op[cç][aã]o\s+(n[aã]o\s+(encontrada|reconhecida)|inv[aá]lida)\b[\s\S]{0,60}\b(escolha|digite|selecione|informe)\b/i,
  /\b(escolha|selecione|digite)\s+uma\s+das\s+(seguintes\s+)?op[cç][oõ]es\b/i,
  /\bdigite\s+(somente|apenas|s[oó])\s+o\s+n[uú]mero\b/i,
  /\bdigite\s+o\s+\*?n[uú]mero\*?\s+da\s+op[cç][aã]o\b/i,
  /\bdigite\s+(a\s+palavra\s+)?[*"“”']*menu\b/i,
  /bem[- ]vind[oa]s?\s*(\(a\)\s*)?(a|à|ao)\s+(nossa\s+|nosso\s+)?(central\s+de\s+atendimento|atendimento\s+(digital|virtual|autom[aá]tico))/i,
];
const FRACOS = [
  /agradece(mos)? (o |seu |pelo |a |sua |pela )?(sua )?(contato|mensagem)/i,
  /(regularize|negocie|renegocie|simula[cç][aã]o)\b/i,
  /\b(bradesco|ita[uú]|santander|nubank|caixa econ[oô]mica|banco do brasil)\b/i,
  /\b(cart[aã]o|contrato)\b.{0,60}\b(atraso|atualiza[cç][aã]o|informa[cç][oõ]es contratuais|dispon[ií]vel)\b/i,
  /estamos [àa] disposi[cç][aã]o/i,
  /vou lhe mandar a tabela/i,
  // Ausência
  /deixe (a )?sua mensagem/i,
  /\b(retornaremos|responderemos|entraremos em contato)\b/i,
  // Convite/propaganda de aplicativo
  /\bconvid(e|ar) (seus )?amigos\b/i,
  /\bganhe (recompensas?|pr[eê]mios?|b[oô]nus|dinheiro|moedas)\b/i,
  /\busando (o )?(seu|meu) c[oó]digo\b/i,
  // `\S{0,200}` e não `\S*`: "https://" repetido 8 mil vezes custava 0,4 s (retrocesso quadrático, 2ª revisão do Codex).
  /https?:\/\/\S{0,200}\b(tiktok|kwai|shopee|temu|shein)\.\S+/i,
  // Saudação de conta comercial: "nós" oferecendo ajuda (14/11/2026: "velas e sabonetes artesanal agradece seu
  // contato. Como podemos ajudar?", resposta ao follow-up da Duda; com 1 sinal só, virou "instabilidade").
  /\bcomo (podemos|poderemos) (te |lhe )?(ajudar|servir)\b/i,
  // Encaminhamento automático para atendente (13/11/2026: "Vamos te direcionar para um de nossos atendentes.
  // • Horário de atendimento: segunda a sexta, das 9h às 18h (... exceto feriados)").
  /\b(um|uma) de noss[oa]s (atendentes|consultor(es|as)|especialistas)\b/i,
  /hor[aá]rio de atendimento\s*:/i,
  /\bexceto feriados\b/i,
  // Menu de empresa sem a frase forte: "escolha a opção que melhor descreve...", "selecione qual desses serviços...".
  /\b(escolha|selecione)\s+(a\s+op[cç][aã]o|uma\s+op[cç][aã]o|qual|o\s+(n[uú]mero|servi[cç]o|setor|assunto))\b/i,
  // Fim de atendimento de central ("Atendimento finalizado, agradecemos o contato", "...segue seu protocolo: 592239624").
  /\batendimento\s+(foi\s+)?(finalizado|encerrado)\b/i,
  /\bprotocolo\b[^\n]{0,25}\d{6,}/i,
  // Pesquisa de satisfação ("Como você avalia o meu atendimento? *5* – Muito satisfeito...").
  COMO_AVALIA_O_ATENDIMENTO,
];

/**
 * Itens de menu numerados ("*[ 1 ]* - Já sou cliente", "1 - Financeiro", "2) Suporte", ou o número em tecla de emoji),
 * em linhas ou na mesma linha. Só conta quando aparecem o 1 e o 2: quem responde um questionário
 * ("2- sim 3- não") ou lista telefones ("(81) 9...") não começa do 1 seguido de texto. Sozinho não
 * é sinal de robô (paciente numera exames e perguntas): só vale junto de um cabeçalho de menu,
 * ver `pareceMensagemAutomatica`.
 */
// Repetições com teto ({0,3}): com `*` em classes vizinhas, "1" seguido de 32 mil espaços levava 2,9 s
// de CPU (retrocesso quadrático, achado na revisão do Codex de 17/11/2026).
const ITEM_DE_MENU = /(?:^|[\s:])[*_~]{0,3}[[(]?[ \t]{0,3}(\d{1,2})[ \t]{0,3}[\])]?[*_~]{0,3}[ \t]{0,3}[*_~]{0,3}(?:[-–—.)]|\uFE0F?\u20E3)[ \t]{0,3}[*_~]{0,3}[ \t]{0,3}[^\d\s]/g;

export function temOpcoesNumeradas(mensagem: string): boolean {
  const numeros = new Set<number>();
  for (const achado of String(mensagem ?? '').matchAll(ITEM_DE_MENU)) numeros.add(Number(achado[1]));
  return numeros.has(1) && numeros.has(2);
}

/**
 * Gente falando SOBRE uma mensagem automática não é robô: "Tentei agendar e apareceu 'opção
 * inválida, digite somente o número'. O que faço?", "Recebi essa mensagem, é de vocês?". Empresa
 * fala "você" com o cliente; quem fala "vocês", "pra mim" e "tentei" é a pessoa. Ficou de fora
 * "não consegui/não entendi", que robô de menu também diz.
 */
const FALA_DE_GENTE = /\b(tentei|apareceu|aparecendo|recebi\s+(ess[ae]|est[ae]|isso|uma?)|mandaram|o\s+que\s+(eu\s+)?(fa[cç]o|devo\s+fazer)|voc[eê]s|pra\s+mim|me\s+ajud[ae]m?)\b/i;
const INICIO_DE_ITEM = new RegExp(ITEM_DE_MENU.source);

/**
 * O texto fora do menu. Em cada linha sai o trecho que vai do primeiro item numerado até o fim do
 * rótulo do último item (primeiro ponto, interrogação ou exclamação). O que vem depois volta a
 * contar: "1 - Consulta 2 - Exame. Vocês fazem ultrassom?" é gente perguntando depois de colar o
 * menu, e "1 - Agendamento 2 - Resultados. Digite uma das opções acima." é a instrução do menu.
 */
function foraDosItens(mensagem: string): string {
  return mensagem
    .split('\n')
    .map((linha) => {
      const primeiro = linha.search(INICIO_DE_ITEM);
      if (primeiro < 0) return linha;
      let ultimo = primeiro;
      for (const achado of linha.matchAll(ITEM_DE_MENU)) ultimo = achado.index ?? ultimo;
      const rotulo = linha.slice(ultimo);
      const fim = rotulo.search(/[.?!](\s|$)/);
      return fim < 0 ? linha.slice(0, primeiro) : `${linha.slice(0, primeiro)} ${rotulo.slice(fim + 1)}`;
    })
    .join('\n');
}

/** Mensagem do WhatsApp vai até ~65 mil caracteres; a cara de robô está no começo. Teto para nenhum regex custar caro. */
const MAX_CARACTERES = 6000;

/** Cabeçalho que pede uma escolha: junto de itens numerados, é menu ("escolha a opção que melhor descreve...", pesquisa de satisfação). */
const PEDE_ESCOLHA = [
  /\b(escolha|selecione)\s+(a\s+op[cç][aã]o|uma\s+op[cç][aã]o|qual|o\s+(n[uú]mero|servi[cç]o|setor|assunto))\b/i,
  COMO_AVALIA_O_ATENDIMENTO,
];

/**
 * Ordem da decisão (reescrita depois de quatro passadas de revisão do Codex em 17/11/2026, que
 * foram derrubando remendos):
 *
 * 1. Menu com cabeçalho: itens numerados (1 e 2) e, FORA dos itens, uma instrução de menu. É o
 *    menu de empresa. Aqui a fala de gente só conta se estiver no cabeçalho ("Tentei agendar e
 *    apareceu: escolha uma das opções 1 - ... 2 - ..."), porque o menu escreve opção na primeira
 *    pessoa ("1 - Recebi uma cobrança").
 * 2. Em qualquer outra mensagem, fala de gente em qualquer lugar do texto inteiro (não só nos 6 mil
 *    primeiros caracteres) decide que não é robô: paciente que numera as perguntas ("1 - Vocês
 *    atendem cardiologia?"), que cita o menu, ou que pede ajuda no fim de um texto encaminhado.
 * 3. Sem fala de gente: um sinal forte, ou dois fracos. Lista numerada sozinha não é sinal: paciente
 *    numera exame e pergunta, e "Bradesco" + lista numerada virava robô.
 */
export function pareceMensagemAutomatica(mensagem: string): boolean {
  const inteiro = String(mensagem ?? '');
  const m = inteiro.slice(0, MAX_CARACTERES);

  if (temOpcoesNumeradas(inteiro)) {
    const cabecalho = foraDosItens(inteiro);
    const inicio = cabecalho.slice(0, MAX_CARACTERES);
    if (FORTES.some((r) => r.test(inicio)) || PEDE_ESCOLHA.some((r) => r.test(inicio))) {
      return !FALA_DE_GENTE.test(cabecalho);
    }
  }

  if (FALA_DE_GENTE.test(inteiro)) return false;
  if (FORTES.some((r) => r.test(m))) return true;
  return FRACOS.filter((r) => r.test(m)).length >= 2;
}
