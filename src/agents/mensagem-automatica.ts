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
];

export function pareceMensagemAutomatica(mensagem: string): boolean {
  const m = String(mensagem ?? '');
  if (FORTES.some((r) => r.test(m))) return true;
  return FRACOS.filter((r) => r.test(m)).length >= 2;
}
