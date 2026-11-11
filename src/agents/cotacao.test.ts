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

  // O modelo escreveu o cartão na linha "• Valor:" e o Pix abaixo: sai sempre no bloco de três linhas (10/11/2026).
  it('resposta com marcadores sai com o texto exato da busca', () => {
    const r = resolverMarcadores([
      'Clínico Geral\n\n• Valor: {{preco:Clínico Geral}}\n💰 DINHEIRO/PIX: {{pix:Clínico Geral}} À VISTA\n\nDatas disponíveis:\n{{datas:Clínico Geral}}',
      'Qual fica melhor pra você? 😊',
    ], cat, titulos);
    expect(r.naoResolvidos).toEqual([]);
    expect(r.resolvidos).toBe(3);
    expect(r.mensagens[0]).toBe(
      'Clínico Geral\n\n• Valor:\n💳 CARTÃO: R$85 - 3X SEM JUROS (Com direito a retorno)\n💰 DINHEIRO/PIX: R$ 75 À VISTA (Com direito a retorno)\n\nDatas disponíveis:\nDr. Edson José\n• Sábado, 17/10 às 07h (ordem de chegada)\nDra. Rayanne Miranda\n• Terça-feira, 20/10 das 09h às 11h (ordem de chegada)',
    );
    expect(r.mensagens[1]).toBe('Qual fica melhor pra você? 😊');
  });

  // LP 03/11/2026: "O atendimento tem direito a retorno independente da forma de pagamento".
  // A planilha só escreve o retorno no valor do cartão; a paciente entendia que o à vista não tinha.
  it('retorno escrito no valor do cartão vale também na linha do pix', () => {
    const psiq = catalogoDoTurno([{ tool: 'conferir_especialidades', result: [
      { nome: 'Psiquiatria (adulto)', preco: 'R$210 - 3X SEM JUROS (Sem direito a retorno)', precoPix: 'R$ 200', disponibilidades: [] },
      { nome: 'Exame X', preco: 'R$ 40', precoPix: 'R$ 38', disponibilidades: [] },
    ] }]);
    const sem = resolverMarcadores(['💳 CARTÃO: {{preco:Psiquiatria (adulto)}}\n💰 DINHEIRO/PIX: {{pix:Psiquiatria (adulto)}} À VISTA'], psiq);
    expect(sem.mensagens[0]).toBe('💳 CARTÃO: R$210 - 3X SEM JUROS (Sem direito a retorno)\n💰 DINHEIRO/PIX: R$ 200 À VISTA (Sem direito a retorno)');
    // o modelo já escreveu o retorno na linha: não duplica
    const ja = resolverMarcadores(['💰 DINHEIRO/PIX: {{pix:Clínico Geral}} À VISTA (com direito a retorno)'], cat);
    expect(ja.mensagens[0]).toBe('💰 DINHEIRO/PIX: R$ 75 À VISTA (com direito a retorno)');
    // preço sem retorno: a linha do pix fica como está
    const nada = resolverMarcadores(['💰 DINHEIRO/PIX: {{pix:Exame X}} À VISTA'], psiq);
    expect(nada.mensagens[0]).toBe('💰 DINHEIRO/PIX: R$ 38 À VISTA');
  });

  // Revisão do PR #32 (03/11/2026): bordas com mais de um item na linha e texto depois do pix.
  it('retorno do pix: bordas da revisão', () => {
    const c = catalogoDoTurno([{ tool: 'conferir_especialidades', result: [
      { nome: 'Psiquiatria (adulto)', preco: 'R$210 - 3X SEM JUROS (Sem direito a retorno)', precoPix: 'R$ 200', disponibilidades: [] },
      { nome: 'Clínico Geral', preco: 'R$85 - 3X SEM JUROS (Com direito a retorno)', precoPix: 'R$ 75', disponibilidades: [] },
    ] }]);
    const um = (l: string) => resolverMarcadores([l], c).mensagens[0];
    // dois pix na mesma linha: não atribui o retorno de um ao outro
    expect(um('Pix: {{pix:Clínico Geral}} ou {{pix:Psiquiatria (adulto)}}')).toBe('Pix: R$ 75 ou R$ 200');
    // texto depois do pix: o retorno entra junto do valor (e do "à vista"), não no fim da frase
    expect(um('Pix: {{pix:Psiquiatria (adulto)}} à vista 😊')).toBe('Pix: R$ 200 à vista (Sem direito a retorno) 😊');
    expect(um('Você paga {{pix:Clínico Geral}} no pix e leva hoje. Aproveite!')).toBe('Você paga R$ 75 (Com direito a retorno) no pix e leva hoje. Aproveite!');
    expect(um('{{pix:Clínico Geral}} à vistaria')).toBe('R$ 75 (Com direito a retorno) à vistaria');
    // retorno de OUTRO item (no preco da mesma linha) não cala o do pix
    expect(um('Cartão {{preco:Psiquiatria (adulto)}} / Pix {{pix:Clínico Geral}}')).toBe(
      'Cartão R$210 - 3X SEM JUROS (Sem direito a retorno) / Pix R$ 75 (Com direito a retorno)',
    );
  });

  it('pix inexistente apaga a linha inteira', () => {
    const r = resolverMarcadores(['• Valor: {{preco:USG Abdome Total}}\n💰 Pix: {{pix:USG Abdome Total}} à vista\nNão exige requisição.'], cat);
    expect(r.mensagens[0]).toBe('• Valor: R$135,00 em até 2x sem juros\nNão exige requisição.');
  });

  it('sem pix, a linha de cartão não fica sozinha: vira "• Valor:" numa linha (LP, 10/11/2026)', () => {
    // O modelo escreve o bloco de duas linhas para todo item; ultrassom e combo não têm pix.
    const r = resolverMarcadores(
      ['ULTRASSOM/USG ABDOME TOTAL\n\n• Valor:\n💳 CARTÃO: {{preco:USG Abdome Total}}\n💰 DINHEIRO/PIX: {{pix:USG Abdome Total}} À VISTA\n\nDatas disponíveis:'],
      cat,
    );
    expect(r.mensagens[0]).toBe('ULTRASSOM/USG ABDOME TOTAL\n\n• Valor: R$135,00 em até 2x sem juros\n\nDatas disponíveis:');
    // Sem a linha "• Valor:" antes, o rótulo de cartão vira o de valor.
    const s = resolverMarcadores(['Combo\n💳 CARTÃO: {{preco:USG Abdome Total}}\n💰 DINHEIRO/PIX: {{pix:USG Abdome Total}} À VISTA'], cat);
    expect(s.mensagens[0]).toBe('Combo\n• Valor: R$135,00 em até 2x sem juros');
  });

  it('com pix, as duas linhas ficam como o modelo escreveu', () => {
    const r = resolverMarcadores(['• Valor:\n💳 CARTÃO: {{preco:Clínico Geral}}\n💰 DINHEIRO/PIX: {{pix:Clínico Geral}} À VISTA'], cat);
    expect(r.mensagens[0]).toBe('• Valor:\n💳 CARTÃO: R$85 - 3X SEM JUROS (Com direito a retorno)\n💰 DINHEIRO/PIX: R$ 75 À VISTA (Com direito a retorno)');
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

  // 10/11/2026 20:25, lead final 8754: a Duda escreveu {{preco:Parecer Cardiológico}} com os três
  // itens de cardiologia no turno; nenhum marcador resolveu e a paciente recebeu "• Valor:" e
  // "Datas disponíveis:" vazios (guard cotacao_reescrita_falhou).
  describe('nome do item sem o parêntese da composição', () => {
    const p = (nome: string, preco: string, precoPix?: string) => ({ nome, preco, precoPix, disponibilidades: [{ 'data/horario': 'quarta, 18/11/2026 - 13:30 - Ordem de chegada', profissional: 'André Macedo' }] });
    const cardio = catalogoDoTurno([{ tool: 'conferir_especialidades', result: [
      p('Cardiologista/Cardiologia (Eletrocardiograma + Parecer Cardiológico + Consulta + Retorno 15 dias)', 'R$170 - 3X SEM JUROS (Com direito a retorno)', 'R$ 160'),
      p('Parecer Cardiológico (Consulta + Eletrocardiograma + Parecer Cardiológico)', 'R$160 - 3X SEM JUROS (Sem direito a retorno)', 'R$ 145'),
      p('Parecer Cardiológico Infantil (Eletrocardiograma + Parecer Cardiológico)', 'R$150 (Sem direito a retorno)'),
    ] }]);

    it('"Parecer Cardiológico" é o adulto, não o infantil nem a cardiologia', () => {
      expect(acharItem('Parecer Cardiológico', cardio)?.preco).toBe('R$160 - 3X SEM JUROS (Sem direito a retorno)');
      expect(acharItem('Parecer Cardiológico Infantil', cardio)?.preco).toBe('R$150 (Sem direito a retorno)');
      expect(acharItem('Cardiologista', cardio)?.precoPix).toBe('R$ 160');
      expect(acharItem('Cardiologia', cardio)?.precoPix).toBe('R$ 160');
    });

    it('o bloco do turno real sai preenchido', () => {
      const r = resolverMarcadores(['Parecer Cardiológico\n• Inclui consulta, eletrocardiograma e parecer cardiológico\n\n• Valor:\n💳 CARTÃO: {{preco:Parecer Cardiológico}}\n💰 DINHEIRO/PIX: {{pix:Parecer Cardiológico}} À VISTA\n\nDatas disponíveis:\n{{datas:Parecer Cardiológico}}'], cardio, { 'André Macedo': 'Dr.' });
      expect(r.naoResolvidos).toEqual([]);
      expect(r.mensagens[0]).toContain('💳 CARTÃO: R$160 - 3X SEM JUROS (Sem direito a retorno)');
      expect(r.mensagens[0]).toContain('💰 DINHEIRO/PIX: R$ 145 À VISTA (Sem direito a retorno)');
      expect(r.mensagens[0]).toContain('Dr. André Macedo\n• Quarta-feira, 18/11 às 13h30 (ordem de chegada)');
    });

    it('dois itens com o mesmo nome antes do parêntese continuam ambíguos (não chuta)', () => {
      const cat = catalogoDoTurno([{ tool: 'conferir_especialidades', result: [p('Eletrocardiograma (sem laudo)', 'R$40'), p('Eletrocardiograma (com laudo)', 'R$160')] }]);
      expect(acharItem('Eletrocardiograma', cat)).toBeNull();
    });
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
