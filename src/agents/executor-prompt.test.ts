import { describe, it, expect } from 'vitest';
import { buildExecutorPrompt } from './executor-prompt';

/**
 * O cache de prompt da OpenAI casa PREFIXO EXATO e só entra em jogo a partir de
 * ~1024 tokens. Token servido de cache custa 1/10.
 *
 * Até 02/09/2026 o Executor montava o system prompt assim:
 *
 *   <data_atual>{data com HORA e MINUTO}</data_atual>
 *   <acoes_executadas>{logs desta conversa}</acoes_executadas>
 *   ...7.912 chars de manual estático...
 *
 * Os dois blocos voláteis ficavam nos primeiros 112 chars. Como o minuto muda a
 * cada minuto e os logs mudam a cada chamada de ferramenta, o prefixo quase
 * nunca se repetia — e o manual inteiro, que é idêntico em toda chamada de todo
 * agente, nunca chegava a ser reaproveitado.
 *
 * Medido em produção nos 5 dias anteriores: Executor com 55,4% de cache contra
 * 79,7% do Orquestrador, que monta prompt estático (`orchestrator.ts:278`).
 *
 * Estes testes travam a ordem. Se alguém puser conteúdo volátil na frente de
 * novo, eles ficam vermelhos.
 */

const LOGS_A = 'agendar_consulta(2026-09-02 14:00) -> ok';
const LOGS_B = 'consultar_preco(raio-x) -> ok\nagendar_consulta(2026-09-03 09:00) -> falhou';

/** Mínimo de cache da OpenAI, com folga: ~1024 tokens a ~4 chars/token. */
const MINIMO_CACHE_CHARS = 4096;

/** Maior prefixo comum entre duas strings. */
function prefixoComum(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

describe('prompt do Executor: o que é estável fica na frente', () => {
  it('não começa com data nem com acoes_executadas', () => {
    const p = buildExecutorPrompt(LOGS_A);
    const inicio = p.slice(0, 200);
    expect(inicio).not.toContain('<data_atual>');
    expect(inicio).not.toContain('<acoes_executadas>');
  });

  it('o manual continua inteiro no prompt — a correção é de ordem, não de corte', () => {
    const p = buildExecutorPrompt(LOGS_A);
    for (const marca of [
      '# PAPEL',
      'Regra de ouro',
      'Regra de deduplicação',
      '# FERRAMENTAS DISPONÍVEIS',
      '# PRIORIDADE DE EXECUÇÃO',
      'REDIRECT_HUMAN=true',
    ]) {
      expect(p).toContain(marca);
    }
    expect(p).toContain('<data_atual>');
    expect(p).toContain('<acoes_executadas>');
    expect(p).toContain(LOGS_A);
  });

  it('dois prompts com logs diferentes compartilham prefixo maior que o mínimo de cache', () => {
    const a = buildExecutorPrompt(LOGS_A);
    const b = buildExecutorPrompt(LOGS_B);
    const comum = prefixoComum(a, b);
    expect(comum).toBeGreaterThan(MINIMO_CACHE_CHARS);
  });

  it('o prefixo comum vai até onde o conteúdo volátil começa, não antes', () => {
    const a = buildExecutorPrompt(LOGS_A);
    const b = buildExecutorPrompt(LOGS_B);
    const comum = prefixoComum(a, b);
    // Tudo que é estável tem que ter cabido no trecho comum.
    expect(a.slice(0, comum)).toContain('REDIRECT_HUMAN=true');
  });

  it('logs vazios não quebram e não encolhem o prefixo estável', () => {
    const vazio = buildExecutorPrompt('');
    const cheio = buildExecutorPrompt(LOGS_B);
    expect(prefixoComum(vazio, cheio)).toBeGreaterThan(MINIMO_CACHE_CHARS);
  });

  it('a regra de deduplicação continua citando o bloco pelo nome da tag', () => {
    // A regra referencia <acoes_executadas> por tag, então mover o bloco não a
    // quebra. Este teste existe para que quem renomear a tag veja o acoplamento.
    const p = buildExecutorPrompt(LOGS_A);
    const regra = p.slice(p.indexOf('Regra de deduplicação'));
    expect(regra).toContain('<acoes_executadas>');
  });
});
