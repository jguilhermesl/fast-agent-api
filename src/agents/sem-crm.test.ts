import { describe, it, expect } from 'vitest';
import { semBlocoCrm } from './sem-crm';
import { EXECUTOR_TOOLS, ORCHESTRATOR_TOOLS } from '../tools/definitions';
import { buildExecutorPrompt } from './executor-prompt';

// 04/11/2026: ninguém usa o estágio de CRM que a IA gravava, e a ordem "sempre que houver
// avanço, inclua uma tarefa do tipo CRM" (bloco <crm> do n8n) gerava rodada e chamada de
// executor só para isso. Sai para todos os agentes: o bloco do prompt, o tipo CRM do
// orquestrador e a ferramenta atualizar_lead_crm do executor. Transferência (lead_status_update)
// é outra coisa e fica.
describe('sem CRM na IA', () => {
  it('tira o bloco <crm> inteiro e mantém o resto', () => {
    const s = 'PERSONA\n\n<dados_usuario>\nNome: X\n</dados_usuario>\n<crm>\nObserve o estágio...\nEstágio atual:\nnew\n</crm>\n<intents_executadas> a </intents_executadas>';
    expect(semBlocoCrm(s)).toBe('PERSONA\n\n<dados_usuario>\nNome: X\n</dados_usuario>\n<intents_executadas> a </intents_executadas>');
  });
  it('sem bloco, devolve igual', () => {
    expect(semBlocoCrm('só persona com CRM ativo do médico')).toBe('só persona com CRM ativo do médico');
  });
  it('executor não tem mais atualizar_lead_crm; orquestrador não tem tipo CRM', () => {
    expect(EXECUTOR_TOOLS.map((t) => t.name)).not.toContain('atualizar_lead_crm');
    const tipo = (ORCHESTRATOR_TOOLS[0].parameters.properties.tasks.items.properties.tipo as { enum: readonly string[] }).enum;
    expect(tipo).not.toContain('CRM');
    expect(ORCHESTRATOR_TOOLS[0].description).not.toMatch(/CRM/);
    expect(buildExecutorPrompt('')).not.toMatch(/atualizar_lead_crm/);
  });
});
