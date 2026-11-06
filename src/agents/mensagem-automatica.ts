/**
 * A mensagem do contato tem cara de robô de empresa (cobrança, banco, resposta automática,
 * menu)? Usado só para aceitar o silêncio do modelo (agents/saida.ts): a persona da Duda manda
 * não responder robô, e o vazio virava "instabilidade" + transferência (04–05/11/2026, 4 casos:
 * Bradesco, cartão ELO, "Kit Festa"). Precisa de 2 sinais, ou 1 sinal forte, para não calar
 * paciente que só cita banco ou "mensagem automática".
 */
const FORTES = [
  /resposta autom[aá]tica\*?\s*\n/i,
  /^\s*\*?resposta autom[aá]tica/i,
  /para n[aã]o receber (novas|mais) mensagens/i,
  /selecione\s+(a op[cç][aã]o|parar)/i,
  /digite\s+\d+\s+para/i,
  /caso (j[aá] )?tenha (realizado|efetuado) o pagamento,?\s*desconsidere/i,
];
const FRACOS = [
  /agradecemos (o |seu |pelo )?contato/i,
  /(regularize|negocie|renegocie|simula[cç][aã]o)\b/i,
  /\b(bradesco|ita[uú]|santander|nubank|caixa econ[oô]mica|banco do brasil)\b/i,
  /\b(cart[aã]o|contrato)\b.{0,60}\b(atraso|atualiza[cç][aã]o|informa[cç][oõ]es contratuais|dispon[ií]vel)\b/i,
  /estamos [àa] disposi[cç][aã]o/i,
  /vou lhe mandar a tabela/i,
];

export function pareceMensagemAutomatica(mensagem: string): boolean {
  const m = String(mensagem ?? '');
  if (FORTES.some((r) => r.test(m))) return true;
  return FRACOS.filter((r) => r.test(m)).length >= 2;
}
