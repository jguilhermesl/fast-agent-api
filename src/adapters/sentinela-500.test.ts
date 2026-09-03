import { describe, it, expect } from 'vitest';
import { sentinelaEnvio500, PREFIXO_SENTINELA_500, ehSentinela500 } from './sentinela-500';

/**
 * O WhatsBizAPI às vezes responde HTTP 500 e entrega a mensagem assim mesmo.
 * Nesse caso o `provider_message_id` real nunca chega até nós, e o adapter grava
 * um sentinela no lugar.
 *
 * Até 03/09/2026 o sentinela era a constante `'sent-with-500-error'`, igual para
 * toda mensagem. Consequência medida em produção: **211 linhas de `messages` com
 * o mesmo `provider_message_id`**, todas `direction='outbound'` — 211 duplicatas
 * na chave do índice único `uniq_messages_provider_direction`. Por isso o índice
 * da SPEC-06 precisou excluí-las com
 * `AND provider_message_id <> 'sent-with-500-error'`, e a consequência real é que
 * **mensagem enviada durante um 500 do provedor não é deduplicada**.
 *
 * Nada se perde tornando o sentinela único: o provedor respondeu 500, o id real
 * nunca foi conhecido, e o valor já era inútil para casar status depois.
 */
describe('sentinela de envio com HTTP 500', () => {
  it('duas chamadas nunca produzem o mesmo id — é o ponto de existir', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 500; i++) vistos.add(sentinelaEnvio500());
    expect(vistos.size).toBe(500);
  });

  it('mantém prefixo estável, para continuar reconhecível em log e em query', () => {
    expect(sentinelaEnvio500().startsWith(PREFIXO_SENTINELA_500)).toBe(true);
  });

  it('ehSentinela500 reconhece o formato novo', () => {
    expect(ehSentinela500(sentinelaEnvio500())).toBe(true);
  });

  // As 211 linhas gravadas antes de 03/09 continuam com a constante antiga. Um
  // reconhecedor que só entendesse o formato novo faria o passado sumir de
  // qualquer relatório que use esta função.
  it('ehSentinela500 AINDA reconhece a constante antiga — as 211 linhas legadas', () => {
    expect(ehSentinela500('sent-with-500-error')).toBe(true);
  });

  it('não confunde id real do provedor com sentinela', () => {
    expect(ehSentinela500('3EB0C767D0B8F1B2A5C4')).toBe(false);
    expect(ehSentinela500('')).toBe(false);
    expect(ehSentinela500(null)).toBe(false);
    expect(ehSentinela500(undefined)).toBe(false);
  });
});
