import { describe, it, expect } from 'vitest';
import { limparEventosDoProvedor } from './entrada';

// Textos reais do provedor, gravados como mensagem do cliente (Duda, 31/08 a 24/09/2026).
describe('limparEventosDoProvedor', () => {
  it('edição de mensagem sozinha não é fala do cliente', () => {
    expect(limparEventosDoProvedor('Unsupported message type: edit')).toBe('');
  });

  it('mensagem apagada sozinha não é fala do cliente', () => {
    expect(limparEventosDoProvedor('Unsupported message type: revoke')).toBe('');
  });

  it('no meio de mensagens agrupadas, sai só a linha do evento', () => {
    const agrupado = 'Me agenda pro dia 13/10\nUnsupported message type: edit\nPode ser de manhã?';
    expect(limparEventosDoProvedor(agrupado)).toBe('Me agenda pro dia 13/10\nPode ser de manhã?');
  });

  it('fala do cliente que só cita a frase continua inteira', () => {
    const texto = 'recebi "Unsupported message type: edit" no meu celular, o que é isso?';
    expect(limparEventosDoProvedor(texto)).toBe(texto);
  });

  it('mensagem comum passa intacta', () => {
    expect(limparEventosDoProvedor('Quanto custa o hemograma?')).toBe('Quanto custa o hemograma?');
  });
});
