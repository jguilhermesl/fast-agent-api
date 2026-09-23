import { describe, it, expect } from 'vitest';
import { buildExecutorPrompt, formatIntentLogs } from './executor-prompt';

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

/**
 * 23/09/2026, Duda (LP Saúde): duas falhas de texto fixo no mesmo dia.
 *
 * 1. A cliente perguntou o valor da USG obstétrica e recebeu o texto de
 *    neuropediatria. O Orquestrador pediu a coisa certa; o Executor, sem intent
 *    de texto para ultrassom, acionou a de outro assunto (exec n8n 287029).
 * 2. Texto de mamografia e de endoscopia saiu duas vezes seguidas para o mesmo
 *    cliente. A regra de deduplicação mandava olhar <acoes_executadas>, mas o
 *    bloco mostrava só a hora, sem data e em UTC.
 */
describe('<acoes_executadas>: data, fuso e argumentos', () => {
  it('mostra data e hora no fuso de <data_atual>, não em UTC', () => {
    // 17:10 UTC = 14:10 em São Paulo
    const s = formatIntentLogs([
      { intent_key: 'enviar_detalhes_mamografia', arguments: {}, success: true, created_at: '2026-09-23T17:10:00Z' },
    ]);
    expect(s).toContain('23/09/2026');
    expect(s).toContain('14:10');
    expect(s).not.toContain('17:10');
  });

  it('separa execução de outro dia da de hoje', () => {
    const s = formatIntentLogs([
      { intent_key: 'enviar_detalhes_neurologia', arguments: {}, success: true, created_at: '2026-06-21T13:47:00Z' },
      { intent_key: 'enviar_detalhes_neurologia', arguments: {}, success: true, created_at: '2026-09-23T13:47:00Z' },
    ]).split('\n');
    expect(s[0]).toContain('21/06/2026');
    expect(s[1]).toContain('23/09/2026');
  });

  it('arguments em objeto (jsonb) sai como JSON, não "[object Object]"', () => {
    const s = formatIntentLogs([
      { intent_key: 'conferir_especialidades', arguments: { terms: 'neurologista' }, success: true, created_at: '2026-09-23T14:07:00Z' },
    ]);
    expect(s).toContain('{"terms":"neurologista"}');
    expect(s).not.toContain('[object Object]');
  });

  it('arguments em string JSON continua funcionando', () => {
    const s = formatIntentLogs([
      { intent_key: 'x', arguments: '{"a":1}', success: false, created_at: '2026-09-23T14:07:00Z' },
    ]);
    expect(s).toContain('{"a":1}');
    expect(s).toContain('✗ falhou');
  });

  it('sem logs devolve o aviso de conversa sem ação', () => {
    expect(formatIntentLogs([])).toBe('(nenhuma ação executada nesta conversa ainda)');
  });
});

describe('regras de texto fixo no manual do Executor', () => {
  it('a dedup de texto fixo vale só para hoje', () => {
    const p = buildExecutorPrompt(LOGS_A);
    const regra = p.slice(p.indexOf('Regra de deduplicação'), p.indexOf('# FERRAMENTAS DISPONÍVEIS'));
    expect(regra).toContain('**hoje**');
    expect(regra).toContain('outro dia');
  });

  it('proíbe acionar texto fixo de outro assunto', () => {
    const p = buildExecutorPrompt(LOGS_A);
    expect(p).toContain('Regra do texto fixo');
    expect(p).toContain('Nunca** acione o texto de outro assunto');
  });

  it('manda o texto fixo do item mesmo quando a tarefa só pede preço', () => {
    // 23/09/2026: "qual o valor da consulta do neuro" saiu só com preço. O
    // Orquestrador escreveu a tarefa citando conferir_especialidades e o Executor
    // seguiu ao pé da letra; o texto oficial de neurologia nunca saiu.
    const p = buildExecutorPrompt(LOGS_A);
    const regra = p.slice(p.indexOf('Regra do texto fixo'), p.indexOf('# FERRAMENTAS DISPONÍVEIS'));
    expect(regra.length).toBeGreaterThan(0);
    expect(regra).toContain('mesmo que a tarefa só fale em valor');
    expect(regra).toContain('texto já ter saído hoje');
  });

  it('depois do texto fixo, só busca se a intent de texto mandar', () => {
    // 17-21/09/2026: o Executor mandava o texto de endoscopia (que já traz o preço) e ainda
    // buscava "endoscopia" em conferir_especialidades, onde o item não existe. A busca
    // voltava vazia e o Orquestrador transferia alegando busca vazia (4 de 9 casos). Teste
    // do pezinho e paternidade são piores: a busca devolve o teste ergométrico.
    const p = buildExecutorPrompt(LOGS_A);
    const regra = p.slice(p.indexOf('Regra do texto fixo'), p.indexOf('# FERRAMENTAS DISPONÍVEIS'));
    expect(regra).toContain('se a descrição daquela intent de texto mandar buscar');
    expect(regra).toContain('não justifica transferência');
    expect(regra).not.toContain('**e** faça a busca');
  });

  it('as regras novas ficam no trecho cacheado, antes do conteúdo volátil', () => {
    const a = buildExecutorPrompt(LOGS_A);
    const b = buildExecutorPrompt(LOGS_B);
    const comum = a.slice(0, prefixoComum(a, b));
    expect(comum).toContain('Regra do texto fixo');
    expect(comum).toContain('outro dia');
  });
});
