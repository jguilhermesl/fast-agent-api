import { describe, it, expect } from 'vitest';
import { amostragemDoModelo } from './modelo-params';

describe('amostragemDoModelo', () => {
  it('manda temperature para os modelos que a aceitam', () => {
    for (const m of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-4.1-mini', 'gpt-5.5']) {
      expect(amostragemDoModelo(m, 0.2)).toEqual({ temperature: 0.2 });
    }
  });

  // Medido contra a API em 22/09/2026: com temperature 0.2 a resposta é
  // HTTP 400 "Only the default (1) value is supported", e com tools sem
  // reasoning_effort='none' é HTTP 400 "Function tools with reasoning_effort are
  // not supported ... in /v1/chat/completions". Qualquer um dos dois derruba o
  // agente inteiro no fallback de segurança, sem gravar um token.
  it('troca temperature por reasoning_effort=none em toda a familia gpt-5.6', () => {
    for (const m of ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna']) {
      const p = amostragemDoModelo(m, 0.2);
      expect(p).toEqual({ reasoning_effort: 'none' });
      expect(p).not.toHaveProperty('temperature');
    }
  });

  // Medido em 16/10/2026: gpt-6-luna dá o mesmo 400 com temperature + tools e
  // responde com reasoning_effort='none'. gpt-6-sol e gpt-6.1-sol recusam 'none'
  // (só low/medium/high) e com tools exigem /v1/responses: continuam no ramo de
  // temperature, onde o 400 é o mesmo que já seria hoje.
  it('trata gpt-6-luna como a familia 5.6, e só ele da familia 6', () => {
    expect(amostragemDoModelo('gpt-6-luna', 0.2)).toEqual({ reasoning_effort: 'none' });
    expect(amostragemDoModelo('gpt-6-luna-2026-09-22', 0.2)).toEqual({ reasoning_effort: 'none' });
    expect(amostragemDoModelo('gpt-6.1-terra', 0.2)).toEqual({ reasoning_effort: 'none' });
    for (const m of ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra']) {
      expect(amostragemDoModelo(m, 0.2)).toEqual({ temperature: 0.2 });
    }
  });

  it('não confunde 5.6 com um prefixo parecido', () => {
    expect(amostragemDoModelo('gpt-5.62-qualquer', 0.3)).toEqual({ temperature: 0.3 });
  });
});
