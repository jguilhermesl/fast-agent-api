import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { systemComCache, ferramentasComCache, mensagensComMarcadorNoFim } from './anthropic-cache';

const marca = { type: 'ephemeral' };

describe('cache de prompt da Anthropic', () => {
  it('o system vira um bloco de texto marcado', () => {
    expect(systemComCache('persona')).toEqual([{ type: 'text', text: 'persona', cache_control: marca }]);
  });

  it('marca só a última ferramenta e não mexe no original', () => {
    const tools = [{ name: 'a' }, { name: 'chamar_executor' }];
    const marcadas = ferramentasComCache(tools);
    expect(marcadas[0]).toEqual({ name: 'a' });
    expect(marcadas[1]).toEqual({ name: 'chamar_executor', cache_control: marca });
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
