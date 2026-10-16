import { describe, it, expect } from 'vitest';
import { notaDeRetomada } from './retomada';

const agora = Date.parse('2026-10-16T15:08:20Z'); // 12:08 BRT

describe('notaDeRetomada', () => {
  it('caso real: última mensagem em 18/09, histórico de Doppler → nota com data e dias', () => {
    const nota = notaDeRetomada('2026-09-18T17:59:26Z', agora, true);
    expect(nota).toMatch(/18\/09/);
    expect(nota).toMatch(/há 27 dias/);
    expect(nota).toMatch(/Não retome nem reofereça o assunto antigo/);
  });

  it('conversa ativa (última há 20 minutos) → sem nota', () => {
    expect(notaDeRetomada('2026-10-16T14:48:00Z', agora, true)).toBeNull();
  });

  it('pausa de 13 horas → nota sem número de dias', () => {
    expect(notaDeRetomada('2026-10-16T02:00:00Z', agora, true)).toMatch(/há mais de 12 horas/);
  });

  it('sem histórico ou sem mensagem anterior → sem nota', () => {
    expect(notaDeRetomada('2026-09-18T17:59:26Z', agora, false)).toBeNull();
    expect(notaDeRetomada(null, agora, true)).toBeNull();
  });
});
