import { describe, it, expect } from 'vitest';
import { textoFixoVizinho } from './texto-fixo-vizinho';

const intents = new Set(['enviar_detalhes_ecocardiograma', 'enviar_detalhes_neurologia', 'enviar_detalhes_mamografia', 'conferir_especialidades']);
// Tarefa real de 16/10/2026 (resumida): o Orquestrador inventou a intent da morfológica.
const tarefaMorfologica = JSON.stringify([
  { tipo: 'AÇÃO', objetivo: 'Executar a intenção enviar_detalhes_morfologica para enviar o texto oficial da ultrassom morfológica' },
  { tipo: 'VENDA', objetivo: 'Buscar datas disponíveis para ultrassom morfológica em conferir_especialidades' },
]);

describe('textoFixoVizinho', () => {
  it('barra o texto vizinho quando a tarefa cita um texto fixo que não existe', () => {
    const motivo = textoFixoVizinho({ tarefa: tarefaMorfologica, ferramenta: 'enviar_detalhes_ecocardiograma', intentsDoAgente: intents });
    expect(motivo).toMatch(/enviar_detalhes_morfologica/);
    expect(motivo).toMatch(/não substitui/);
  });

  it('deixa passar a busca do item, mesmo com a intent inventada na tarefa', () => {
    expect(textoFixoVizinho({ tarefa: tarefaMorfologica, ferramenta: 'conferir_especialidades', intentsDoAgente: intents })).toBeNull();
  });

  it('deixa passar o texto fixo que a tarefa citou e que existe', () => {
    const tarefa = JSON.stringify([{ objetivo: 'Executar enviar_detalhes_neurologia' }]);
    expect(textoFixoVizinho({ tarefa, ferramenta: 'enviar_detalhes_neurologia', intentsDoAgente: intents })).toBeNull();
  });

  it('não age quando a tarefa não cita nenhum texto fixo pelo nome', () => {
    const tarefa = JSON.stringify([{ objetivo: 'Consultar valor do ecocardiograma' }]);
    expect(textoFixoVizinho({ tarefa, ferramenta: 'enviar_detalhes_ecocardiograma', intentsDoAgente: intents })).toBeNull();
  });

  it('com uma citada inexistente e outra existente, só a existente passa', () => {
    const tarefa = JSON.stringify([{ objetivo: 'enviar_detalhes_morfologica e enviar_detalhes_mamografia' }]);
    expect(textoFixoVizinho({ tarefa, ferramenta: 'enviar_detalhes_mamografia', intentsDoAgente: intents })).toBeNull();
    expect(textoFixoVizinho({ tarefa, ferramenta: 'enviar_detalhes_ecocardiograma', intentsDoAgente: intents })).not.toBeNull();
  });
});
