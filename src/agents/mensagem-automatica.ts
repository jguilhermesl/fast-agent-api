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
  /https?:\/\/\S*\b(tiktok|kwai|shopee|temu|shein)\.\S+/i,
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
  /\bcomo\s+voc[eê]\s+avalia\b/i,
];

/**
 * Itens de menu numerados ("*[ 1 ]* - Já sou cliente", "1 - Financeiro", "2) Suporte", ou o número em tecla de emoji),
 * em linhas ou na mesma linha. Só conta quando aparecem o 1 e o 2: quem responde um questionário
 * ("2- sim 3- não") ou lista telefones ("(81) 9...") não começa do 1 seguido de texto. Sinal fraco:
 * paciente também numera exames ("1. hemograma 2. glicemia").
 */
const ITEM_DE_MENU = /(?:^|[\s:])[*_~]*[[(]?[ \t]*(\d{1,2})[ \t]*[\])]?[*_~]*[ \t]*[*_~]*(?:[-–—.)]|\uFE0F?\u20E3)[ \t]*[*_~]*[ \t]*[^\d\s]/g;

export function temOpcoesNumeradas(mensagem: string): boolean {
  const numeros = new Set<number>();
  for (const achado of String(mensagem ?? '').matchAll(ITEM_DE_MENU)) numeros.add(Number(achado[1]));
  return numeros.has(1) && numeros.has(2);
}

export function pareceMensagemAutomatica(mensagem: string): boolean {
  const m = String(mensagem ?? '');
  if (FORTES.some((r) => r.test(m))) return true;
  return FRACOS.filter((r) => r.test(m)).length + (temOpcoesNumeradas(m) ? 1 : 0) >= 2;
}
