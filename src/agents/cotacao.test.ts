import { describe, it, expect } from 'vitest';
import { catalogoDoTurno, acharItem, linhaDeData, blocoDeDatas, resolverMarcadores, nomeComTitulo, temMarcador } from './cotacao';

// Retornos reais da busca (16/10/2026), resumidos.
const usgAbdome = [
  {
    nome: 'ULTRASSOM/USG ABDOME TOTAL', preco: 'R$135,00 em até 2x sem juros', detalhe: 'Não exige requisição médica.',
    disponibilidades: [
      { 'data/horario': 'segunda, 19/10/2026 - 11:00 - Ordem de chegada', profissional: 'Francisco Gadelha' },
      { 'data/horario': 'quarta, 21/10/2026 - 14:30 - Ordem de chegada', profissional: 'Francisco Gadelha' },
      { 'data/horario': 'quinta, 29/10/2026 - 10:30 - Ordem de chegada', profissional: 'Misael Mustafa' },
    ],
  },
  { nome: 'ULTRASSOM/USG ABDOME TOTAL COM DOPPLER', preco: 'R$235,00 em até 2x sem juros', disponibilidades: [] },
];
const clinico = [
  {
    nome: 'Clínico Geral', preco: 'R$85 - 3X SEM JUROS (Com direito a retorno)', precoPix: 'R$ 75',
    disponibilidades: [
      { 'data/horario': 'sábado, 17/10/2026 - 07:00 - Ordem de chegada', profissional: 'Edson José' },
      { 'data/horario': 'terça, 20/10/2026 - 09:00 as 11:00 - Ordem de chegada', profissional: 'Rayanne Miranda' },
    ],
  },
];
const sangue = [{ nome: 'HEMOGRAMA COMPLETO, HEMOGRAMA COM PLAQUETAS', preco: 'R$ 15,00', detalhes: null }];
const titulos = { 'Edson José': 'Dr.', 'Rayanne Miranda': 'Dra.', 'Francisco Gadelha': 'Dr.', 'Misael Mustafa': 'Dr.' };

const tools = [
  { tool: 'conferir_especialidades', result: usgAbdome },
  { tool: 'conferir_especialidades', result: JSON.stringify(clinico) },
  { tool: 'conferir_valores_de_exame_de_sangue_e_urina', result: sangue },
  { tool: 'atualizar_lead_crm', result: { ok: true } },
  { tool: 'enviar_detalhes_oftalmo', result: { message: 'Workflow was started' } },
];

describe('cotação no código', () => {
  const cat = catalogoDoTurno(tools);

  it('catálogo pega só itens de busca (com nome), resultado em string ou objeto', () => {
    expect(cat.map((i) => i.nome)).toEqual([
      'ULTRASSOM/USG ABDOME TOTAL', 'ULTRASSOM/USG ABDOME TOTAL COM DOPPLER', 'Clínico Geral', 'HEMOGRAMA COMPLETO, HEMOGRAMA COM PLAQUETAS',
    ]);
  });

  it('acha o item pelo nome que o modelo escreveu, preferindo o mais específico', () => {
    expect(acharItem('USG Abdome Total', cat)?.nome).toBe('ULTRASSOM/USG ABDOME TOTAL');
    expect(acharItem('ultrassom abdome total com doppler', cat)?.nome).toBe('ULTRASSOM/USG ABDOME TOTAL COM DOPPLER');
    expect(acharItem('clinico geral', cat)?.nome).toBe('Clínico Geral');
    expect(acharItem('Hemograma completo', cat)?.nome).toBe('HEMOGRAMA COMPLETO, HEMOGRAMA COM PLAQUETAS');
    expect(acharItem('Raio-X do joelho', cat)).toBeNull();
  });

  it('formatos reais de horário da agenda', () => {
    expect(linhaDeData('segunda, 19/10/2026 - 11:00 - Ordem de chegada')).toBe('Segunda-feira, 19/10 às 11h (ordem de chegada)');
    expect(linhaDeData('quarta, 21/10/2026 - 14:30 - Ordem de chegada')).toBe('Quarta-feira, 21/10 às 14h30 (ordem de chegada)');
    expect(linhaDeData('sexta, 23/10/2026 - 08h as 09h30 - Ordem de chegada')).toBe('Sexta-feira, 23/10 das 08h às 09h30 (ordem de chegada)');
    expect(linhaDeData('terça, 20/10/2026 - 09:00 as 11:00 - Ordem de chegada')).toBe('Terça-feira, 20/10 das 09h às 11h (ordem de chegada)');
    expect(linhaDeData('quinta, 22/10/2026 - 12:30  - Ordem de chegada')).toBe('Quinta-feira, 22/10 às 12h30 (ordem de chegada)');
    expect(linhaDeData('quinta, 22/10/2026 - 09:00- Ordem de chegada')).toBe('Quinta-feira, 22/10 às 09h (ordem de chegada)');
    expect(linhaDeData('segunda, 26/10/2026 - Hora marcada (a equipe confirma o horário)')).toBe('Segunda-feira, 26/10 (hora marcada, a equipe confirma o horário)');
    expect(linhaDeData('segunda, 26/10/2026 - (hora marcada)')).toBe('Segunda-feira, 26/10 (hora marcada)');
    expect(linhaDeData('quarta, 21/10/2026 - Quartas-feiras (a equipe confirma o horário)')).toBe('Quarta-feira, 21/10 (quartas-feiras, a equipe confirma o horário)');
    expect(linhaDeData('sábado, 31/10/2026')).toBe('Sábado, 31/10');
    expect(linhaDeData('formato estranho')).toBe('formato estranho');
  });

  it('título só para quem está na lista do agente', () => {
    expect(nomeComTitulo('Edson José', titulos)).toBe('Dr. Edson José');
    expect(nomeComTitulo('Livya Regina', titulos)).toBe('Livya Regina');
    expect(nomeComTitulo('DR. ROGÉRIO BATISTA', titulos)).toBe('DR. ROGÉRIO BATISTA');
  });

  it('bloco de datas agrupado por profissional, com título', () => {
    expect(blocoDeDatas(cat[0], titulos)).toBe(
      'Dr. Francisco Gadelha\n• Segunda-feira, 19/10 às 11h (ordem de chegada)\n• Quarta-feira, 21/10 às 14h30 (ordem de chegada)\nDr. Misael Mustafa\n• Quinta-feira, 29/10 às 10h30 (ordem de chegada)',
    );
    expect(blocoDeDatas(cat[1], titulos)).toBe('Sem data aberta na agenda no momento.');
  });

  it('resposta com marcadores sai com o texto exato da busca', () => {
    const r = resolverMarcadores([
      'Clínico Geral\n\n• Valor: {{preco:Clínico Geral}}\n💰 DINHEIRO/PIX: {{pix:Clínico Geral}} À VISTA\n\nDatas disponíveis:\n{{datas:Clínico Geral}}',
      'Qual fica melhor pra você? 😊',
    ], cat, titulos);
    expect(r.naoResolvidos).toEqual([]);
    expect(r.resolvidos).toBe(3);
    expect(r.mensagens[0]).toBe(
      'Clínico Geral\n\n• Valor: R$85 - 3X SEM JUROS (Com direito a retorno)\n💰 DINHEIRO/PIX: R$ 75 À VISTA\n\nDatas disponíveis:\nDr. Edson José\n• Sábado, 17/10 às 07h (ordem de chegada)\nDra. Rayanne Miranda\n• Terça-feira, 20/10 das 09h às 11h (ordem de chegada)',
    );
    expect(r.mensagens[1]).toBe('Qual fica melhor pra você? 😊');
  });

  it('pix inexistente apaga a linha inteira', () => {
    const r = resolverMarcadores(['• Valor: {{preco:USG Abdome Total}}\n💰 Pix: {{pix:USG Abdome Total}} à vista\nNão exige requisição.'], cat);
    expect(r.mensagens[0]).toBe('• Valor: R$135,00 em até 2x sem juros\nNão exige requisição.');
  });

  it('item que a busca não trouxe fica marcado como não resolvido (quem chama decide)', () => {
    const r = resolverMarcadores(['Raio-X: {{preco:Raio-X do joelho}}'], cat);
    expect(r.naoResolvidos).toEqual(['preco:Raio-X do joelho']);
    expect(r.mensagens[0]).toContain('{{preco:Raio-X do joelho}}');
  });

  it('exame de sangue em lista', () => {
    const r = resolverMarcadores(['• Hemograma completo, {{preco:Hemograma completo}}'], cat);
    expect(r.mensagens[0]).toBe('• Hemograma completo, R$ 15,00');
  });

  it('detecta marcador barato', () => {
    expect(temMarcador(['oi'])).toBe(false);
    expect(temMarcador(['• Valor: {{preco: X }}'])).toBe(true);
  });
});

describe('cotação: achados da revisão de 16/10', () => {
  const mk = (nome: string, preco: string, disponibilidades: unknown[] = []) => ({ tool: 'conferir_especialidades', result: [{ nome, preco, disponibilidades }] });

  it('não troca joelho por tornozelo nem LDL por colesterol total', () => {
    const cat = catalogoDoTurno([mk('Raio-X do tornozelo', 'R$ 70,00'), mk('Colesterol', 'R$ 10,00'), mk('Colesterol HDL', 'R$ 12,00')]);
    expect(acharItem('Raio-X do joelho', cat)).toBeNull();
    expect(acharItem('Colesterol LDL', cat)).toBeNull();
    expect(acharItem('Colesterol HDL', cat)?.preco).toBe('R$ 12,00');
    expect(acharItem('exame de Colesterol', cat)?.preco).toBe('R$ 10,00');
  });

  it('marcador com acento ou "valor" também resolve; marcador torto nunca passa como texto resolvido', () => {
    const cat = catalogoDoTurno([mk('Clínico Geral', 'R$85 - 3X SEM JUROS')]);
    expect(resolverMarcadores(['A: {{preço:Clínico Geral}}', 'B: {{valor:Clínico Geral}}'], cat).mensagens).toEqual(['A: R$85 - 3X SEM JUROS', 'B: R$85 - 3X SEM JUROS']);
    expect(temMarcador(['{{Preco Clínico}}'])).toBe(true);
    expect(temMarcador(['valor }}'])).toBe(true);
  });

  it('datas sem profissional vão antes dos grupos com nome', () => {
    const cat = catalogoDoTurno([mk('Ultrassom', 'R$ 1', [
      { 'data/horario': 'segunda, 19/10/2026 - 11:00 - Ordem de chegada', profissional: 'Francisco Gadelha' },
      { 'data/horario': 'terça, 20/10/2026 - 08:00 - Ordem de chegada', profissional: '-' },
      { 'data/horario': 'quarta, 21/10/2026 - 09:00 - Ordem de chegada', profissional: 'Misael Mustafa' },
    ])]);
    expect(blocoDeDatas(cat[0], {})).toBe(
      '• Terça-feira, 20/10 às 08h (ordem de chegada)\nFrancisco Gadelha\n• Segunda-feira, 19/10 às 11h (ordem de chegada)\nMisael Mustafa\n• Quarta-feira, 21/10 às 09h (ordem de chegada)',
    );
  });

  it('agenda com nulo ou profissional não-texto não derruba', () => {
    const cat = catalogoDoTurno([mk('Ultrassom', 'R$ 1', [null, 7, { 'data/horario': 'sábado, 31/10/2026', profissional: 123 }])]);
    expect(() => blocoDeDatas(cat[0], {})).not.toThrow();
    expect(blocoDeDatas(cat[0], {})).toBe('123\n• Sábado, 31/10');
  });
});

describe('cotação: envelope real do intent-dispatcher', () => {
  it('desce por status/data/data até a lista de itens', () => {
    const envelope = { status: 'ok', http_status: 200, data: { success: true, status: 200, intent: { slug: 'conferir_especialidades' }, data: [
      { nome: 'Prevenção, Preventivo, Prevenção Completa, Papanicolau, Citologia + Colposcopia', preco: 'R$ 150,00 (Sem direito a retorno)', disponibilidades: [] },
    ] } };
    const cat = catalogoDoTurno([{ tool: 'conferir_especialidades', result: envelope }, { tool: 'atualizar_lead_crm', result: { status: 'error', data: { error: 'x' } } }]);
    expect(cat.map((i) => i.preco)).toEqual(['R$ 150,00 (Sem direito a retorno)']);
    expect(resolverMarcadores(['• Valor: {{preco:Prevenção completa}}'], cat).mensagens).toEqual(['• Valor: R$ 150,00 (Sem direito a retorno)']);
  });
});

describe('cotação: achados da suíte de 16/10', () => {
  const mk = (nome: string, disponibilidades: unknown[] = []) => ({ tool: 'conferir_especialidades', result: [{ nome, preco: 'R$ 1', disponibilidades }] });

  it('"Psiquiatria" casa o apelido exato do adulto, não a infantil', () => {
    const cat = catalogoDoTurno([mk('Psiquiatria Infantil'), mk('Psiquiatria, Psiquiatra, atestado físico e mental, atestado psiquiátrico')]);
    expect(acharItem('Psiquiatria', cat)?.nome).toMatch(/^Psiquiatria, Psiquiatra/);
    expect(acharItem('Psiquiatria Infantil', cat)?.nome).toBe('Psiquiatria Infantil');
  });

  it('ambíguo sem apelido exato não chuta', () => {
    const cat = catalogoDoTurno([mk('Cardiologia adulto'), mk('Cardiologia infantil')]);
    expect(acharItem('cardiologia', cat)).toBeNull();
  });

  it('{{datas:ITEM|PROFISSIONAL}} filtra (parecer para concurso só com o Dr. André)', () => {
    const cat = catalogoDoTurno([mk('Parecer Cardiológico', [
      { 'data/horario': 'quarta, 21/10/2026 - 13:30 - Ordem de chegada', profissional: 'André Macedo' },
      { 'data/horario': 'sábado, 24/10/2026 - 09:30 - Ordem de chegada', profissional: 'Juliana Russo' },
    ])]);
    const r = resolverMarcadores(['{{datas:Parecer Cardiológico|André Macedo}}'], cat, { 'André Macedo': 'Dr.', 'Juliana Russo': 'Dra.' });
    expect(r.mensagens[0]).toBe('Dr. André Macedo\n• Quarta-feira, 21/10 às 13h30 (ordem de chegada)');
    expect(r.mensagens[0]).not.toContain('Juliana');
  });
});
