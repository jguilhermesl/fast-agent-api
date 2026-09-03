import { randomUUID } from 'crypto';

/**
 * Sentinela gravado em `messages.provider_message_id` quando o provedor responde
 * HTTP 500 mas entrega a mensagem — caso real e recorrente do WhatsBizAPI.
 *
 * Mora em módulo próprio, sem dependência de `config`, para ser testável, pelo
 * mesmo motivo de `saudacao.ts` e `executor-prompt.ts`.
 *
 * ## Por que precisa ser único
 *
 * Até 03/09/2026 isto era a constante `'sent-with-500-error'`, idêntica para toda
 * mensagem. Medido em produção nessa data: **211 linhas de `messages` com esse
 * mesmo valor**, todas `direction='outbound'` — ou seja, 211 duplicatas exatas na
 * chave do índice único `uniq_messages_provider_direction (provider_message_id,
 * direction)`.
 *
 * Foi por isso que o índice da SPEC-06 nasceu com uma exclusão:
 *
 *     WHERE provider_message_id IS NOT NULL
 *       AND provider_message_id <> 'sent-with-500-error'
 *
 * E a consequência prática dessa exclusão é que **mensagem enviada durante um 500
 * do provedor não é deduplicada** — exatamente a janela em que o reenvio é mais
 * provável, porque o chamador não sabe se a primeira entrega aconteceu.
 *
 * Tornar o sentinela único não perde informação nenhuma: o provedor respondeu
 * 500, o id real nunca foi conhecido, e o valor já era inútil para casar status
 * depois. O que se ganha é a linha voltar a caber no índice.
 *
 * ## O que ainda NÃO foi feito
 *
 * As 211 linhas antigas continuam com a constante. Remover o `AND` do índice
 * **falha com violação de unicidade** enquanto elas existirem — a nota da
 * `FILA-DE-APROVACAO.md` que manda simplesmente "remover o AND quando subir"
 * está incompleta. Ordem correta:
 *
 *   1. este módulo em produção (ids novos já nascem únicos);
 *   2. backfill das 211 linhas legadas com id único — escrita em `messages` de
 *      produção, exige decisão do dono;
 *   3. só então recriar o índice sem a exclusão.
 */
export const PREFIXO_SENTINELA_500 = 'sent-with-500-';

/** Valor usado antes de 03/09/2026. Continua no banco em 211 linhas. */
export const SENTINELA_500_LEGADO = 'sent-with-500-error';

/** Um sentinela novo, único por chamada. */
export function sentinelaEnvio500(): string {
  return `${PREFIXO_SENTINELA_500}${randomUUID()}`;
}

/**
 * Reconhece sentinela de 500, no formato novo E no legado.
 *
 * Precisa aceitar os dois: um reconhecedor que só entendesse o formato novo
 * faria as 211 linhas do passado sumirem de qualquer relatório.
 */
export function ehSentinela500(valor: string | null | undefined): boolean {
  if (!valor) return false;
  return valor === SENTINELA_500_LEGADO || valor.startsWith(PREFIXO_SENTINELA_500);
}
