import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { systemComCache, ferramentasComCache, mensagensComMarcadorNoFim, mensagensComMarcadores } from './anthropic-cache';
import { comLembrete } from './anthropic-executor-obrigatorio';

const marca = { type: 'ephemeral' };
// 03/11/2026: o que não muda entre turnos (ferramentas e system) fica 1 h; mensagem e fim, 5 min.
const marca1h = { type: 'ephemeral', ttl: '1h' };

describe('cache de prompt da Anthropic', () => {
  it('o system vira um bloco de texto marcado', () => {
    expect(systemComCache('persona')).toEqual([{ type: 'text', text: 'persona', cache_control: marca1h }]);
  });

  it('marca só a última ferramenta e não mexe no original', () => {
    const tools = [{ name: 'a' }, { name: 'chamar_executor' }];
    const marcadas = ferramentasComCache(tools);
    expect(marcadas[0]).toEqual({ name: 'a' });
    expect(marcadas[1]).toEqual({ name: 'chamar_executor', cache_control: marca1h });
    expect(tools[1]).toEqual({ name: 'chamar_executor' });
  });

  it('a mensagem final em texto vira bloco marcado; as anteriores ficam como estão', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
      { role: 'user', content: 'quanto custa o ortopedista?' },
    ];
    const marcadas = mensagensComMarcadorNoFim(msgs);
    expect(marcadas[0]).toEqual({ role: 'user', content: 'oi' });
    expect(marcadas[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'quanto custa o ortopedista?', cache_control: marca }] });
    expect(msgs[2]).toEqual({ role: 'user', content: 'quanto custa o ortopedista?' });
  });

  it('na rodada depois do Executor, marca o último tool_result', () => {
    const msgs = [
      { role: 'user', content: 'valor do ortopedista' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R$170' }] },
    ] as Anthropic.MessageParam[];
    const marcadas = mensagensComMarcadorNoFim(msgs);
    expect(marcadas[1].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'R$170', cache_control: marca }]);
  });

  it('chamar de novo não acumula marca: parte sempre do array sem marca', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: 'a' }];
    mensagensComMarcadorNoFim(msgs);
    const segunda = mensagensComMarcadorNoFim([...msgs, { role: 'assistant', content: 'b' }]);
    expect(segunda[0]).toEqual({ role: 'user', content: 'a' });
  });

  it('texto vazio fica sem marca (a API recusa bloco de texto vazio)', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: '   ' }];
    expect(mensagensComMarcadorNoFim(msgs)).toBe(msgs);
  });
});

import { separarSystemDoTurno } from './anthropic-cache';

// 03/11/2026: a marca ficava só no fim. Na rodada 0 o fim é o LEMBRETE_EXECUTOR, que a
// rodada 1 não tem: o prefixo com a mensagem do turno nunca era lido do cache (78% das
// linhas de custo da Duda com `cached` = múltiplo exato do prefixo fixo).
describe('mensagensComMarcadores: marca também a mensagem do turno', () => {
  const hist: Anthropic.MessageParam[] = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'Olá!' },
  ];
  const turno: Anthropic.MessageParam = { role: 'user', content: 'quanto custa o hemograma?' };

  it('rodada 0 com lembrete: marca o 1º bloco da mensagem do turno e o lembrete', () => {
    const r0 = mensagensComMarcadores(comLembrete([...hist, turno], 'LEMBRETE'), 2);
    expect(r0[2].content).toEqual([
      { type: 'text', text: 'quanto custa o hemograma?', cache_control: marca },
      { type: 'text', text: 'LEMBRETE', cache_control: marca },
    ]);
    expect(r0.slice(0, 2)).toEqual(hist);
  });

  it('rodada 1: o bloco do turno sai igual ao da rodada 0 (mesmo prefixo) e o fim é marcado', () => {
    const r1 = mensagensComMarcadores([
      ...hist, turno,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'executor', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R$ 15' }, { type: 'text', text: 'RESPONDA' }] },
    ] as Anthropic.MessageParam[], 2);
    expect(r1[2].content).toEqual([{ type: 'text', text: 'quanto custa o hemograma?', cache_control: marca }]);
    const fim = r1[4].content as unknown as Array<Record<string, unknown>>;
    expect(fim[1]).toEqual({ type: 'text', text: 'RESPONDA', cache_control: marca });
    expect(fim[0].cache_control).toBeUndefined();
  });

  it('turno é a última mensagem e sem lembrete: uma marca só (limite de 4 da API)', () => {
    const r = mensagensComMarcadores([...hist, turno], 2);
    expect(r[2].content).toEqual([{ type: 'text', text: 'quanto custa o hemograma?', cache_control: marca }]);
    const marcas = JSON.stringify(r).split('cache_control').length - 1;
    expect(marcas).toBe(1);
  });

  it('índice fora do array ou texto vazio: cai no comportamento antigo (só o fim)', () => {
    expect(mensagensComMarcadores([...hist, turno], 9)).toEqual(mensagensComMarcadorNoFim([...hist, turno]));
    const vazio: Anthropic.MessageParam[] = [...hist, { role: 'user', content: '  ' }];
    expect(mensagensComMarcadores(vazio, 2)).toEqual(mensagensComMarcadorNoFim(vazio));
  });
});

describe('separarSystemDoTurno', () => {
  it('persona fica fixa; dados do cliente, horário e CRM vão para o turno', () => {
    const system = '# PAPEL\nVocê é a Duda.\n\n<dados_usuario>\nNome: Fulana\nHorário: quinta-feira, 15/10/2026 23:47\n</dados_usuario>\n<crm>\nnew\n</crm>';
    const { fixo, doTurno } = separarSystemDoTurno(system);
    expect(fixo).toBe('# PAPEL\nVocê é a Duda.');
    expect(doTurno.startsWith('<dados_usuario>')).toBe(true);
    expect(doTurno).toContain('23:47');
    expect(fixo).not.toContain('23:47');
  });

  it('dois turnos com horário diferente têm a mesma parte fixa (é o que deixa o cache valer)', () => {
    const a = separarSystemDoTurno('PERSONA\n<dados_usuario>\nHorário: 12:08\n</dados_usuario>');
    const b = separarSystemDoTurno('PERSONA\n<dados_usuario>\nHorário: 12:09\n</dados_usuario>');
    expect(a.fixo).toBe(b.fixo);
  });

  it('system sem o bloco fica inteiro como fixo', () => {
    expect(separarSystemDoTurno('só persona')).toEqual({ fixo: 'só persona', doTurno: '' });
  });
});
