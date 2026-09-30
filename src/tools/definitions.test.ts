import { describe, it, expect } from 'vitest';
import { ORCHESTRATOR_TOOLS, toOpenAITools, toAnthropicTools } from './definitions';

const chamarExecutor = ORCHESTRATOR_TOOLS.find((t) => t.name === 'chamar_executor')!;
const props = chamarExecutor.parameters.properties.tasks.items.properties;

describe('chamar_executor: campo "valor"', () => {
  const valor = props.valor.description;

  // O destino real do `valor` num agendamento é o `conversion_value` (numérico) da
  // conversão `sale`, gravada pelo n8n "Realizar agendamento" (Duda e Carol).
  it('em AGENDAMENTO é o preço, não data/hora', () => {
    expect(valor).not.toMatch(/AGENDAMENTO \(data\/hora\)/);
    expect(valor).toMatch(/AGENDAMENTO, VENDA e CONVERSÃO: o preço/);
    expect(valor).toMatch(/R\$ 170,00/);
  });

  it('proíbe data e horário no campo e diz para onde eles vão', () => {
    expect(valor).toMatch(/Nunca ponha data ou horário aqui/);
    expect(valor).toMatch(/data e horário vão em "contexto"/);
  });

  it('CRM continua usando "valor" para o estágio (o Executor lê SOMENTE esse campo no CRM)', () => {
    expect(valor).toMatch(/CRM: o slug do novo estágio do funil/);
  });

  it('a descrição do tipo AGENDAMENTO aponta o mesmo contrato', () => {
    expect(props.tipo.description).toMatch(/AGENDAMENTO=agendar serviço\/consulta \(data e horário vão em "contexto", o preço vai em "valor"\)/);
  });
});

describe('chamar_executor: uma chamada por turno, com UMA nova tentativa de busca', () => {
  const d = chamarExecutor.description;

  it('continua exigindo todas as tarefas juntas numa chamada', () => {
    expect(d).toMatch(/TODAS as tarefas do turno juntas no array "tasks", numa chamada só/);
    expect(d).toMatch(/nunca divida as tarefas em várias chamadas/);
  });

  it('não diz mais "Nunca chame múltiplas vezes" (brigava com "refaça a busca" da persona)', () => {
    expect(d).not.toMatch(/Nunca chame múltiplas vezes/);
    expect(d).not.toMatch(/APENAS UMA VEZ por turno/);
  });

  it('abre exceção só para busca vazia ou item errado, uma vez, sem loop', () => {
    expect(d).toMatch(/BUSCA_VAZIA ou um item diferente do que o cliente pediu/);
    expect(d).toMatch(/mais UMA vez neste turno, só com a busca refeita com outro termo/);
    expect(d).toMatch(/Nunca repita a mesma busca com o mesmo termo e nunca chame uma terceira vez/);
  });
});

describe('conversores levam o texto novo aos dois provedores', () => {
  it('OpenAI', () => {
    const t = toOpenAITools(ORCHESTRATOR_TOOLS)[0] as { function: { description: string; parameters: unknown } };
    expect(t.function.description).toBe(chamarExecutor.description);
    expect(JSON.stringify(t.function.parameters)).toContain('o preço em reais do item');
  });
  it('Anthropic', () => {
    const t = toAnthropicTools(ORCHESTRATOR_TOOLS)[0] as { description: string; input_schema: unknown };
    expect(t.description).toBe(chamarExecutor.description);
    expect(JSON.stringify(t.input_schema)).toContain('o preço em reais do item');
  });
});
