import { describe, it, expect } from 'vitest';
import { semBuscaNaBase } from './kb-sem-busca';

// 03/11/2026, Duda: 11 treinamentos (5,2 mil chars) eram `ondemand` e o executor buscava com
// embedding da OpenAI (regra do dono: zero OpenAI na Duda); 60% das 367 buscas/7d voltavam
// vazias. Com tudo no prompt, `prompt_config.kb.busca = false` tira a ferramenta do executor.
describe('semBuscaNaBase', () => {
  const tools = [{ name: 'agent_knowledge_base' }, { name: 'atualizar_lead_crm' }, { name: 'conferir_especialidades' }];

  it('com a busca desligada, tira só a agent_knowledge_base', () => {
    expect(semBuscaNaBase(tools, true).map((t) => t.name)).toEqual(['atualizar_lead_crm', 'conferir_especialidades']);
  });

  it('sem a chave (padrão), nada muda', () => {
    expect(semBuscaNaBase(tools, false)).toBe(tools);
  });
});
