import { describe, it, expect } from 'vitest';
import { esquemaEstilo } from './esquema-estilo';

describe('esquemaEstilo (corpo do /api/chat)', () => {
  it('aceita emoji booleano e "raro"', () => {
    expect(esquemaEstilo.safeParse({ emoji: false, dividir: true }).success).toBe(true);
    expect(esquemaEstilo.safeParse({ emoji: 'raro' }).success).toBe(true);
    expect(esquemaEstilo.safeParse({}).success).toBe(true);
  });

  it('recusa outro texto em emoji', () => {
    expect(esquemaEstilo.safeParse({ emoji: 'pouco' }).success).toBe(false);
  });
});
