import { describe, it, expect } from 'vitest';
import { checarGrounding, checarTarefaSemFerramenta, historicoConfiavel } from './guard';
import type { ChatMessage, ToolCallLog } from '../types';

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

  // Os três casos abaixo eram falso positivo medido em tráfego real (01-02/09/2026).
  it('"às 15h" e "15:00" são o mesmo horário', () => {
    const v = checarGrounding({ ...vazio, mensagens: ['Fica às 15h então.'], toolResults: 'slot 15:00 ordem de chegada' });
    expect(v.verdict).toBe('ok');
  });

  it('"01/09" e "01/09/2026" são a mesma data', () => {
    const v = checarGrounding({ ...vazio, mensagens: ['Tenho 01/09.'], toolResults: 'terça, 01/09/2026 - 09:30' });
    expect(v.verdict).toBe('ok');
  });

  it('não gera token de 2 dígitos solto (era o ruído que marcava a Carol)', () => {
    const v = checarGrounding({ ...vazio, mensagens: ['Item 22 da lista, seção 08.'] });
    expect(v.tokens_sem_lastro).toEqual([]);
  });
});

describe('historicoConfiavel — a alucinação não pode servir de lastro para si mesma', () => {
  // Reproduz o incidente: no turno 1 o agente inventou "R$ 100,00" sem chamar
  // ferramenta nenhuma. Testado contra o lead real 50404509: com o histórico
  // inteiro no corpus, o guard dava `ok` em TODOS os turnos, inclusive nos que
  // inventaram preço e horário.
  const historico: ChatMessage[] = [
    { role: 'user', content: 'Tem atendimento com o clínico no horário da tarde?' },
    { role: 'assistant', content: 'Consulta: R$ 100,00 — 31/08 às 13:00', tools: ['atualizar_lead_crm'] },
    { role: 'user', content: 'Amanhã a tarde tem ?' },
  ];

  it('descarta fala do agente em turno que só mexeu no CRM', () => {
    const corpus = historicoConfiavel(historico);
    expect(corpus).not.toContain('R$ 100,00');
    expect(corpus).toContain('Amanhã a tarde tem ?');
  });

  it('mantém fala do agente quando o turno rodou ferramenta de negócio', () => {
    const comBusca: ChatMessage[] = [
      { role: 'assistant', content: 'A consulta é R$ 85,00', tools: ['conferir_especialidades', 'atualizar_lead_crm'] },
    ];
    expect(historicoConfiavel(comBusca)).toContain('R$ 85,00');
  });

  it('mantém tudo que o cliente disse', () => {
    expect(historicoConfiavel([{ role: 'user', content: 'pode ser às 15h?' }])).toContain('15h');
  });

  it('com o corpus certo, o turno 2 do incidente é acusado', () => {
    const v = checarGrounding({
      mensagens: ['💰 Valor: R$ 100,00', '🩺 *Dr. João Silva*', '• Terça-feira, 01/09 às 15h'],
      toolResults: '### CRM\nEstágio do lead atualizado para orçamento.',
      clientMessage: 'Amanhã a tarde tem ?',
      history: historicoConfiavel(historico),
      systemPrompt: 'Persona sem preço de clínico geral.',
    });
    expect(v.verdict).toBe('ungrounded');
    expect(v.tokens_sem_lastro).toContain('10000');
  });

  it('e com o histórico INTEIRO ele deixa passar — a prova do defeito', () => {
    const v = checarGrounding({
      mensagens: ['💰 Valor: R$ 100,00'],
      toolResults: '### CRM',
      clientMessage: 'Amanhã a tarde tem ?',
      history: historico.map((m) => m.content).join('\n'), // o jeito ANTIGO
      systemPrompt: 'Persona sem preço de clínico geral.',
    });
    expect(v.verdict).toBe('ok');
  });
});
