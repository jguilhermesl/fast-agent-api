/**
 * Conversa retomada depois de pausa longa: o histórico é de outro atendimento.
 *
 * 16/10/2026 12:08 (Duda, lead f293922d): a paciente tinha perguntado de Doppler
 * venoso em 18/09. Hoje mandou só "Oi boa tarde" e a resposta foi "A data que te
 * passei antes já passou. Hoje a próxima vaga do ULTRASSOM DOPPLER VENOSO… Quer que
 * eu reserve essa vaga?". Um minuto depois ela perguntou de exame de alergia. O
 * histórico do Redis não tem data, então o modelo trata o assunto de 28 dias atrás
 * como a conversa de agora (o mesmo defeito anotado no gpt-5.4 como "histórico
 * antigo vira atual").
 *
 * A nota vai só na mensagem do cliente deste turno, nunca no histórico.
 */

/** Pausa a partir da qual o histórico é tratado como de outro atendimento. */
export const PAUSA_RETOMADA_MS = 12 * 60 * 60 * 1000;

/** Janela do turno atual: mensagens mais novas que isto são do próprio turno (rajada). */
export const JANELA_DO_TURNO_MS = 10 * 60 * 1000;

const ddmm = (d: Date) =>
  d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });

/**
 * @param ultimaAnteriorIso última mensagem da conversa (qualquer lado, sem as de sistema)
 *   anterior à janela do turno atual; null quando não há ou a leitura falhou.
 */
export function notaDeRetomada(ultimaAnteriorIso: string | null, agora: number, temHistorico: boolean): string | null {
  if (!temHistorico || !ultimaAnteriorIso) return null;
  const quando = new Date(ultimaAnteriorIso);
  const pausa = agora - quando.getTime();
  if (!Number.isFinite(pausa) || pausa < PAUSA_RETOMADA_MS) return null;
  const dias = Math.floor(pausa / (24 * 60 * 60 * 1000));
  const ha = dias >= 1 ? `há ${dias} dia${dias > 1 ? 's' : ''}` : 'há mais de 12 horas';
  return (
    `[Nota interna, não é do cliente: a conversa anterior com este cliente foi em ${ddmm(quando)}, ${ha}. ` +
    'O histórico é daquele atendimento e pode estar vencido (datas, vagas, exame pedido). Responda só ao que ' +
    'o cliente escreveu agora. Não retome nem reofereça o assunto antigo, a menos que ele mesmo traga.]'
  );
}
