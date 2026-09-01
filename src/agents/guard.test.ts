import { describe, it, expect } from 'vitest';
import { checarGrounding, checarTarefaSemFerramenta } from './guard';
import type { ToolCallLog } from '../types';

const tool = (nome: string): ToolCallLog => ({ tool: nome, arguments: {}, result: {} } as ToolCallLog);

// O caso real que motivou o guard: lead 50404509, Duda, 31/08/2026.
const TAREFAS_VENDA_E_CRM = JSON.stringify([
  { tipo: 'VENDA', objetivo: 'Consultar valor e agenda de Clínico Geral' },
  { tipo: 'CRM', objetivo: 'Atualizar estágio', valor: 'em-atendimento' },
]);

describe('checarTarefaSemFerramenta', () => {
  it('acusa quando o Executor só mexeu no CRM e a tarefa era de negócio', () => {
    const v = checarTarefaSemFerramenta(TAREFAS_VENDA_E_CRM, [tool('atualizar_lead_crm')]);
    expect(v.verdict).toBe('tarefa_sem_ferramenta');
    expect(v.tipos_pedidos).toEqual(['VENDA']);
  });

  it('fica ok quando a ferramenta de negócio rodou', () => {
    const v = checarTarefaSemFerramenta(TAREFAS_VENDA_E_CRM, [
      tool('conferir_especialidades'),
      tool('atualizar_lead_crm'),
    ]);
    expect(v.verdict).toBe('ok');
  });

  it('fica ok quando só havia tarefa de CRM — não é caso deste guard', () => {
    const v = checarTarefaSemFerramenta(
      JSON.stringify([{ tipo: 'CRM', valor: 'agendado' }]),
      [tool('atualizar_lead_crm')],
    );
    expect(v.verdict).toBe('ok');
    expect(v.tipos_pedidos).toEqual([]);
  });

  it('fica ok quando a tarefa era TRANSFERÊNCIA — ela não chama ferramenta por desenho', () => {
    const v = checarTarefaSemFerramenta(JSON.stringify([{ tipo: 'TRANSFERÊNCIA' }]), []);
    expect(v.verdict).toBe('ok');
  });

  it('não quebra com query ausente ou ilegível', () => {
    expect(checarTarefaSemFerramenta(undefined, []).verdict).toBe('ok');
    expect(checarTarefaSemFerramenta('não é json', []).verdict).toBe('ok');
    expect(checarTarefaSemFerramenta('{"tipo":"VENDA"}', []).verdict).toBe('ok'); // objeto, não array
  });
});

describe('checarGrounding', () => {
  const vazio = { toolResults: '', clientMessage: '', history: '', systemPrompt: '' };

  it('acusa o preço e o horário inventados do caso Erilaine', () => {
    const v = checarGrounding({
      ...vazio,
      mensagens: [
        'Tenho sim atendimento de clínico geral amanhã à tarde.',
        '💰 Valor: R$ 100,00',
        '🩺 *Dr. João Silva*\n• Terça-feira, 01/09 às 13h\n• Terça-feira, 01/09 às 15h',
      ],
      toolResults: '### CRM\nEstágio do lead atualizado com sucesso para orçamento.',
    });
    expect(v.verdict).toBe('ungrounded');
    expect(v.tokens_sem_lastro).toContain('10000'); // R$ 100,00
  });

  it('aprova quando o valor veio do retorno da ferramenta', () => {
    const v = checarGrounding({
      ...vazio,
      mensagens: ['A consulta é R$ 85,00 e tenho 01/09 às 09:30.'],
      toolResults: '[{"preco":"R$ 85,00","disponibilidades":[{"data/horario":"terça, 01/09/2026 - 09:30"}]}]',
    });
    expect(v.verdict).toBe('ok');
  });

  it('aprova quando o valor mora na persona — a KB da Duda foi migrada pro prompt', () => {
    const v = checarGrounding({
      ...vazio,
      mensagens: ['A avaliação odontológica custa R$ 60,00 no particular.'],
      systemPrompt: 'A avaliação odontológica é R$ 60,00 no particular e gratuita no LP Benefícios.',
    });
    expect(v.verdict).toBe('ok');
  });

  it('aprova quando o agente ecoa o horário que o próprio cliente propôs', () => {
    const v = checarGrounding({
      ...vazio,
      mensagens: ['Perfeito, anotei 15h.'],
      clientMessage: 'pode ser às 15h?',
    });
    expect(v.verdict).toBe('ok');
  });

  it('ignora número longo demais para ser preço ou horário (telefone)', () => {
    const v = checarGrounding({ ...vazio, mensagens: ['Meu contato é 5581994933356.'] });
    expect(v.tokens_sem_lastro).toEqual([]);
  });
});
