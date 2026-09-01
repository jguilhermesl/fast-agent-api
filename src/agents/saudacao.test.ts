import { describe, it, expect } from 'vitest';
import { isGreetingOrFarewell } from './saudacao';

// `isGreetingOrFarewell(msg) === true` desliga `tool_choice: 'required'` no round 0.
// Falso positivo aqui = o agente fala de agenda e preço sem consultar nada.
describe('isGreetingOrFarewell', () => {
  const saudacaoPura = [
    'oi', 'Oi!', 'Olá', 'ola', 'opa', 'e aí',
    'Bom dia', 'Bom dia!', 'boa tarde', 'Boa noite…',
    'obrigado', 'Muito obrigada!', 'valeu', 'tchau', 'até mais',
  ];
  for (const m of saudacaoPura) {
    it(`"${m}" é saudação pura`, () => expect(isGreetingOrFarewell(m)).toBe(true));
  }

  // Todas estas casavam o PREFIXO na versão antiga e desligavam a busca. São
  // exatamente o formato de fala de paciente de clínica.
  const saudacaoComPergunta = [
    'Bom dia, tem consulta hoje?',
    'Boa tarde, quais horários tem para cardiologista?',
    'Oi, tem vaga pra ortopedista amanhã?',
    'Olá, quanto custa o ultrassom?',
    'oi quero marcar',
    'Obrigada, mas tem outro horário?',
  ];
  for (const m of saudacaoComPergunta) {
    it(`"${m}" NÃO é saudação pura`, () => expect(isGreetingOrFarewell(m)).toBe(false));
  }

  it('mensagem longa nunca conta como saudação', () => {
    expect(isGreetingOrFarewell('Bom dia ' + 'a'.repeat(40))).toBe(false);
  });
});
