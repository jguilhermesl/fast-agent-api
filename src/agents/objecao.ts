// Pré-classificação de recusa × objeção na mensagem do cliente.
//
// Mora fora do orchestrator pelo mesmo motivo de `saudacao.ts`: o orchestrator
// importa `config`, que exige as env vars do servidor, e função pura tem que ser
// testável sem ambiente.
//
// O que existia até 30/09/2026: uma lista só, OBJECTION_PATTERNS, que marcava como
// OBJEÇÃO tanto "tá caro" quanto "não quero", "não tenho interesse", "não, obrigado",
// "não posso", "não vou" — e o prefixo mandava aplicar o roteiro de objeção e não
// encerrar. Resultado medido na Duda (estudo 02, §3.3): 12 de 16 recusas depois de
// 24/09 ganharam nova investida ("NÃO TENHO INTERESSE!!!" → "É algo que você quer
// resolver logo ou ainda está se organizando?"). E "não posso"/"não vou" pegavam quem
// queria REMARCAR ("Eu não posso ir esse mês não"), que recebia argumento de venda.
//
// Agora são três saídas:
//   - 'recusa'  : a pessoa disse não. Acolher, deixar a porta aberta uma vez, parar.
//   - 'objecao' : ainda não disse não, mas trava num motivo com argumento (preço, distância).
//   - null      : o resto, inclusive adiamento ("vou pensar") e pedido de remarcar,
//                 que ficam com a persona.
//
// O custo do erro é assimétrico. Falso positivo de recusa cala uma venda de quem só
// estava negociando; falso negativo deixa o caso com a persona, que também tem a
// regra. Por isso a recusa é conservadora: pergunta (tem "?") e pedido sobre
// agendamento (remarcar, cancelar, outro dia) nunca são recusa.

export type ClassificacaoMensagem = 'recusa' | 'objecao' | null;

/** Mensagem acima disso tem conteúdo demais para um rótulo de uma palavra. */
const LIMITE_CHARS = 200;

const RECUSA_PATTERNS = [
  // "não, obrigado", "não obrigada", "não, valeu"
  /\bn[ãa]o[\s,.!]+(obrigad[oa]|valeu)\b/i,
  // "não tenho interesse", "não tenho mais interesse", "sem interesse"
  /\bn[ãa]o\s+tenho\s+(mais\s+)?interesse\b/i,
  /\bsem\s+interesse\b/i,
  // "não quero", "não quero mais", "não quero não" — só quando termina aí. "não quero
  // de manhã" e "não quero esse" são preferência, não recusa.
  /\bn[ãa]o\s+quero(\s+(mais|n[ãa]o|nada|agora))*\s*([.!,;]|$)/i,
  // "não preciso", "não preciso mais" — idem. "não preciso de jejum" não entra.
  /\bn[ãa]o\s+preciso(\s+(mais|n[ãa]o|agora))*\s*([.!,;]|$)/i,
  // Sem \b no fim: depois de "á" o \b do JavaScript não enxerga fronteira.
  /\bdeixa\s+pra\s+l[áa](?![a-zà-ú])/i,
  /\besquece\b/i,
  /\bdesist(i|o)\b/i,
  /\bn[ãa]o\s+[ée]\s+pra\s+mim\b/i,
];

/**
 * Pedido sobre agendamento existente ou troca de data: não é recusa, é trabalho
 * para a equipe (a persona manda transferir). "Não cancela, não quero pra outra
 * semana" era marcado como objeção.
 */
const NAO_E_RECUSA = /\?|remarc|desmarc|cancel|reagend|adiar|adia\b|outr[oa]\s+(dia|data|semana|hor[áa]rio|m[êe]s|vez)|trocar|mudar/i;

const OBJECAO_PATTERNS = [
  /(t[áa]|est[áa]|achei|muito|meio|bem|ficou)\s+caro/i,
  /\bcar[oa]\s+demais\b/i,
  /(é|e|fica|ficou|muito|bem|meio)\s+longe/i,
];

export function classificarMensagem(message: string): ClassificacaoMensagem {
  const texto = message.trim();
  if (!texto || texto.length > LIMITE_CHARS) return null;
  // Recusa vence objeção: "não tenho interesse, é muito longe" é um não com motivo.
  if (RECUSA_PATTERNS.some((p) => p.test(texto)) && !NAO_E_RECUSA.test(texto)) return 'recusa';
  if (OBJECAO_PATTERNS.some((p) => p.test(texto))) return 'objecao';
  return null;
}

/** Texto do prefixo de objeção: o mesmo de antes de 30/09, para não mudar o que já funcionava. */
export const PREFIXO_OBJECAO =
  '[PRÉ-CLASSIFICAÇÃO AUTOMÁTICA: OBJEÇÃO (categoria A) — aplique as regras de tratamento de objeção da PERSONA. NÃO encerre a conversa. NÃO acione "Encerrar conversa".]';

/**
 * Recusa explícita. Diz em voz alta que NÃO é objeção porque até 30/09/2026 o prompt
 * base do n8n (compartilhado por todos os agentes) listava "não, obrigado" e "não
 * quero" como exemplo da categoria A. Desde então o n8n tem a categoria A2 (RECUSA
 * EXPLÍCITA) com a mesma regra deste prefixo. Não manda encerrar: quem encerra é o
 * cliente, e encerrar muda o estado do lead no CRM.
 */
export const PREFIXO_RECUSA =
  '[PRÉ-CLASSIFICAÇÃO AUTOMÁTICA: RECUSA EXPLÍCITA — o cliente disse não. Isto NÃO é objeção: não insista, não argumente, não pergunte o motivo e não ofereça parcelamento, desconto, vaga, outra data ou outro serviço. Responda em uma frase curta que respeita a decisão e diga uma única vez que ele pode voltar a falar por aqui quando quiser. NÃO acione "Encerrar conversa".]';

/** Prefixo a colocar antes da mensagem do cliente, ou '' quando não há pré-classificação. */
export function prefixoDeClassificacao(message: string): string {
  const c = classificarMensagem(message);
  if (c === 'recusa') return PREFIXO_RECUSA;
  if (c === 'objecao') return PREFIXO_OBJECAO;
  return '';
}
