import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  montarPrompt,
  montarConhecimento,
  formatarIntencoes,
  formatarInicioConversa,
  formatarNomeContato,
  formatarHorario,
  LIMITE_CONHECIMENTO,
  type EntradaMontador,
} from './montar-prompt';
import { TEXTO_FIXO, TRANSFERENCIA_DESLIGADA, ESTILO_RESPOSTA, TEXTO_FIXO_FONTE_SHA256 } from './texto-fixo';
import { separarSystemDoTurno } from '../anthropic-cache';
import g1 from './__fixtures__/gabarito-1.json';
import g2 from './__fixtures__/gabarito-2.json';
import g3 from './__fixtures__/gabarito-3.json';
import g4 from './__fixtures__/gabarito-4.json';
import g5 from './__fixtures__/gabarito-5.json';

// Os gabaritos têm a FORMA de execuções reais do AGENTE BASE (23/10/2026), com todo dado de cliente
// final, persona e base trocados por texto fictício. O `esperado` de cada um foi montado pelo código
// ORIGINAL dos nós do n8n (Montar_Conhecimento, Formata_Intents, Pack_Inicio_Conversa) sobre esses
// dados fictícios, em cima do texto fixo da expressão. Contra execuções reais (fora do repo, 226 de
// 4 agentes) o montador deu 226/226 iguais byte a byte; este teste fixa o comportamento.
const GABARITOS = [g1, g2, g3, g4, g5];

function paraEntrada(f: { entrada: unknown }): EntradaMontador {
  const e = f.entrada as Omit<EntradaMontador, 'agora'> & { agora: string };
  return { ...e, agora: new Date(e.agora) } as EntradaMontador;
}

const BASE: EntradaMontador = {
  promptConfig: {
    system_prompt: 'PERSONA',
    variables: { communication_tone: 'normal', company_name: 'Empresa X', company_description: 'Descrição X' },
    handoff_rules: { enabled: true, keywords: ['- a', '- b'] },
  },
  treinamentos: [],
  intencoesExecutadas: [],
  crm: { estagioAtual: 'new', estagiosDisponiveis: ['new', 'lead'] },
  inicioConversa: [],
  contatoNome: 'ana',
  contatoTelefone: '5581900000000',
  agora: new Date('2026-10-23T21:52:00.000Z'),
};

function com(parcial: Partial<EntradaMontador>): EntradaMontador {
  return { ...BASE, ...parcial };
}

describe('montarPrompt: gabaritos', () => {
  GABARITOS.forEach((f, i) => {
    it(`gabarito ${i + 1} (${f.descricao.slice(0, 60)}...) sai igual byte a byte`, () => {
      expect(montarPrompt(paraEntrada(f))).toBe(f.esperado);
    });
  });

  it('os gabaritos cobrem mais de uma forma: base vazia, base cheia, sem intenção, com intenção', () => {
    const base = (f: { esperado: string }) =>
      f.esperado.split('<base_de_conhecimento>\n')[1].split('\n</base_de_conhecimento>')[0];
    expect(base(g1)).toBe('');
    expect(base(g3).length).toBeGreaterThan(100);
    expect(g1.esperado).toContain('✓ google_calendar_listar_eventos');
    expect(g2.entrada.intencoesExecutadas).toHaveLength(0);
  });
});

describe('texto fixo', () => {
  it('são 15 pedaços (14 interpolações) e o tamanho bate com o que veio da expressão', () => {
    expect(TEXTO_FIXO).toHaveLength(15);
    // expressão de 10.627 caracteres sem o "=": 14 interpolações ocupam 1.310 caracteres entre as chaves
    expect(TEXTO_FIXO.reduce((s, p) => s + p.length, 0)).toBe(9317);
    expect(TEXTO_FIXO_FONTE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserva os espaços no fim de linha que o n8n manda', () => {
    const t = TEXTO_FIXO.join('|');
    expect(t).toContain('situações abaixo, \nvocê DEVE');
    expect(t).toContain('ex: \n"Um segundo, já te retorno." \n"Um momento."');
  });

  it('quem lê o prompt para dividir o system (anthropic-cache) continua achando `<dados_usuario>`', () => {
    const { fixo, doTurno } = separarSystemDoTurno(montarPrompt(BASE));
    expect(fixo.length).toBeGreaterThan(0);
    expect(doTurno.startsWith('<dados_usuario>')).toBe(true);
  });

  it('o hash registrado não é de string vazia (guarda contra o arquivo gerado errado)', () => {
    expect(TEXTO_FIXO_FONTE_SHA256).not.toBe(createHash('sha256').update('').digest('hex'));
  });
});

describe('Montar_Conhecimento', () => {
  it('junta "## título\\nconteúdo" com linha em branco, na ordem recebida', () => {
    expect(
      montarConhecimento([
        { name: 'A', content: 'um' },
        { name: 'B', content: 'dois' },
      ]),
    ).toBe('## A\num\n\n## B\ndois');
  });

  it('descarta ondemand, filha de chunk (boolean ou "true") e conteúdo vazio; mantém sem título', () => {
    expect(
      montarConhecimento([
        { name: 'Fica', content: ' x \n', injection_mode: 'always' },
        { name: 'Fora1', content: 'y', injection_mode: 'ondemand' },
        { name: 'Fora2', content: 'y', metadata: { is_chunk_sibling: true } },
        { name: 'Fora3', content: 'y', metadata: { is_chunk_sibling: 'true' } },
        { name: 'Fora4', content: '   ' },
        { name: ' ', content: 'sem título' },
        { name: 'Fica2', content: 'z', metadata: { is_chunk_sibling: false } },
        { name: 'Fica3', content: 'w', injection_mode: 'desconhecido', metadata: null },
      ]),
    ).toBe('## Fica\nx\n\nsem título\n\n## Fica2\nz\n\n## Fica3\nw');
  });

  it('corta em 30.000 caracteres sem aviso e o corte entra no prompt', () => {
    const k = montarConhecimento([{ name: 'Grande', content: 'a'.repeat(40000) }]);
    expect(k).toHaveLength(LIMITE_CONHECIMENTO);
    expect(k.startsWith('## Grande\naaa')).toBe(true);
    const p = montarPrompt(com({ treinamentos: [{ name: 'Grande', content: 'a'.repeat(40000) }] }));
    expect(p).toContain('a'.repeat(1000));
    expect(p).not.toContain('a'.repeat(30000));
  });

  it('exatamente no limite não corta', () => {
    const conteudo = 'b'.repeat(LIMITE_CONHECIMENTO - '## T\n'.length);
    expect(montarConhecimento([{ name: 'T', content: conteudo }])).toHaveLength(LIMITE_CONHECIMENTO);
  });

  it('lista vazia = base vazia', () => {
    expect(montarConhecimento([])).toBe('');
  });
});

describe('Formata_Intents', () => {
  it('hora de Brasília, ✓/✗, argumentos (objeto ou string JSON) cortados em 120', () => {
    const out = formatarIntencoes([
      { intent_key: 'a', success: true, arguments: { x: 1, y: 'z' }, created_at: '2026-10-23T21:51:00+00:00' },
      { intent_key: 'b', success: false, arguments: '{"k":"' + 'q'.repeat(200) + '"}', created_at: '2026-10-23T02:05:00Z' },
      { intent_key: 'c', success: true, arguments: null, created_at: '2026-10-23T12:00:00Z' },
      { intent_key: 'd', success: true, arguments: 'não é json', created_at: '2026-10-23T12:00:00Z' },
    ]);
    expect(out.split('\n')).toEqual([
      '[18:51] ✓ a | x=1, y=z',
      '[23:05] ✗ b | k=' + 'q'.repeat(120),
      '[09:00] ✓ c',
      '[09:00] ✓ d',
    ]);
  });

  it('ignora linha sem intent_key e devolve vazio sem linhas', () => {
    expect(formatarIntencoes([{ intent_key: null, success: true, created_at: '2026-10-23T12:00:00Z' }])).toBe('');
    expect(formatarIntencoes([])).toBe('');
  });
});

describe('Pack_Inicio_Conversa', () => {
  it('"- " + texto sem espaços nas pontas, até 180 caracteres, no máximo 4 linhas, pula vazias', () => {
    const out = formatarInicioConversa([
      { content: '  oi  ' },
      { content: '' },
      { content: null },
      { content: 'x'.repeat(300) },
      { content: 'c' },
      { content: 'd' },
      { content: 'e' },
    ]);
    expect(out.split('\n')).toEqual(['- oi', '- ' + 'x'.repeat(180), '- c', '- d']);
  });

  it('sem mensagens = vazio', () => {
    expect(formatarInicioConversa([])).toBe('');
  });
});

describe('ClienteNome', () => {
  it('capitaliza cada palavra como o n8n, tira espaço sobrando e aceita vazio/nulo', () => {
    expect(formatarNomeContato('ANA  maria dA SILVA')).toBe('Ana Maria Da Silva');
    expect(formatarNomeContato('  joão ')).toBe('João');
    expect(formatarNomeContato('carla 😘')).toBe('Carla 😘');
    expect(formatarNomeContato('')).toBe('');
    expect(formatarNomeContato(null)).toBe('');
  });
});

describe('Horário (pt-BR, Brasília)', () => {
  it('dia da semana por extenso em minúsculas, dd/MM/yyyy HH:mm', () => {
    const casos: Array<[string, string]> = [
      ['2026-10-19T15:00:00Z', 'segunda-feira, 19/10/2026 12:00'],
      ['2026-10-20T15:00:00Z', 'terça-feira, 20/10/2026 12:00'],
      ['2026-10-21T15:00:00Z', 'quarta-feira, 21/10/2026 12:00'],
      ['2026-10-22T15:00:00Z', 'quinta-feira, 22/10/2026 12:00'],
      ['2026-10-23T21:52:00Z', 'sexta-feira, 23/10/2026 18:52'],
      ['2026-10-24T15:00:00Z', 'sábado, 24/10/2026 12:00'],
      ['2026-10-25T15:00:00Z', 'domingo, 25/10/2026 12:00'],
    ];
    for (const [iso, esperado] of casos) expect(formatarHorario(new Date(iso))).toBe(esperado);
  });

  it('usa o dia de Brasília, não o de UTC, e a hora 00 (não 24)', () => {
    expect(formatarHorario(new Date('2026-10-27T02:59:00Z'))).toBe('segunda-feira, 26/10/2026 23:59');
    expect(formatarHorario(new Date('2026-10-23T03:05:00Z'))).toBe('sexta-feira, 23/10/2026 00:05');
    expect(formatarHorario(new Date('2026-10-23T03:00:00Z'))).toBe('sexta-feira, 23/10/2026 00:00');
  });
});

describe('interpolações do prompt', () => {
  it('estilo de resposta: conciso e detalhado entram; equilibrado, ausente e desconhecido ficam vazios', () => {
    const linha = (rc: Record<string, unknown>) =>
      montarPrompt(com({ promptConfig: { ...BASE.promptConfig, ...rc } })).split('Tom: normal\n')[1].split('\n\nRegras:')[0];
    expect(linha({ response_style: 'conciso' })).toBe(ESTILO_RESPOSTA.conciso);
    expect(linha({ response_style: 'detalhado' })).toBe(ESTILO_RESPOSTA.detalhado);
    expect(linha({ response_style: 'equilibrado' })).toBe('');
    expect(linha({})).toBe('');
    expect(linha({ response_style: 'inventado' })).toBe('');
    expect(linha({ response_style: 'constructor' })).toBe('');
    expect(ESTILO_RESPOSTA.conciso).toContain('(\"como te falei, tenho dia 27\")');
  });

  const regras = (rc: Record<string, unknown>) =>
    montarPrompt(com({ promptConfig: { ...BASE.promptConfig, ...rc } })).split('<regras>\n')[1].split('\n</regras>')[0];

  it('transferência: palavras-chave em array saem unidas por vírgula (como o n8n), string sai como está', () => {
    expect(regras({ handoff_rules: { enabled: true, keywords: ['- a.', '- b.'] } })).toBe('- a.,- b.');
    expect(regras({ handoff_rules: { keywords: '- só texto' } })).toBe('- só texto');
  });

  it('transferência desligada troca tudo pelo aviso fixo', () => {
    const texto = regras({ handoff_rules: { enabled: false, keywords: ['- a.'] } });
    expect(texto).toBe(TRANSFERENCIA_DESLIGADA);
    expect(texto).toBe(
      'Nenhuma. A transferência automática está DESLIGADA para este agente: não defina "redirect_human": true por iniciativa própria.',
    );
  });

  it('transferência ausente fica vazia em vez de quebrar', () => {
    expect(regras({ handoff_rules: undefined })).toBe('');
  });

  it('tom e empresa saem de prompt_config.variables, objeto ou string JSON', () => {
    const objeto = montarPrompt(
      com({ promptConfig: { ...BASE.promptConfig, variables: { communication_tone: 'descontraído', company_name: 'N', company_description: 'D' } } }),
    );
    const texto = montarPrompt(
      com({
        promptConfig: {
          ...BASE.promptConfig,
          variables: JSON.stringify({ communication_tone: 'descontraído', company_name: 'N', company_description: 'D' }),
        },
      }),
    );
    expect(objeto).toBe(texto);
    expect(objeto).toContain('Tom: descontraído\n');
    expect(objeto).toContain('<dados_empresa>\nNome: N\nDescrição: D\n</dados_empresa>');
  });

  it('sem variables, tom e empresa saem vazios', () => {
    const p = montarPrompt(com({ promptConfig: { system_prompt: 'P', handoff_rules: { keywords: [] } } }));
    expect(p).toContain('Tom: \n');
    expect(p).toContain('<dados_empresa>\nNome: \nDescrição: \n</dados_empresa>');
  });

  it('CRM: sem o passo de estágios, os dois campos saem vazios; sem estágio atual só o primeiro', () => {
    const vazio = montarPrompt(com({ crm: null }));
    expect(vazio).toContain('Estágio atual:\n\n\nEstágios disponíveis:\n\n</crm>');
    const semAtual = montarPrompt(com({ crm: { estagioAtual: null, estagiosDisponiveis: ['new', 'won'] } }));
    expect(semAtual).toContain('Estágio atual:\n\n\nEstágios disponíveis:\nnew,won\n</crm>');
  });

  it('persona com $&, $1, {{ }} e crase entra literal', () => {
    const persona = 'a $& b $1 c {{ $json.x }} `d` $$ e';
    const p = montarPrompt(com({ promptConfig: { ...BASE.promptConfig, system_prompt: persona } }));
    expect(p).toContain('# COMPORTAMENTO\n' + persona + '\n\n# INTENÇÕES DO SYSTEM PROMPT');
  });

  it('a base de conhecimento e as intenções entram nos lugares certos', () => {
    const p = montarPrompt(
      com({
        treinamentos: [{ name: 'T', content: 'c' }],
        intencoesExecutadas: [{ intent_key: 'k', success: true, created_at: '2026-10-23T21:51:00Z' }],
        inicioConversa: [{ content: 'oi' }],
      }),
    );
    expect(p).toContain('<base_de_conhecimento>\n## T\nc\n</base_de_conhecimento>');
    expect(p).toContain('<intents_executadas>\n[18:51] ✓ k\n</intents_executadas>');
    expect(p.endsWith('(nome, queixa, cidade).\n- oi\n</inicio_da_conversa>')).toBe(true);
  });
});
