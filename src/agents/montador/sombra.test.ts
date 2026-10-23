import { describe, it, expect } from 'vitest';
import { compararComN8n, mascararDadosDeCliente, vereditoDe, TRECHO_MAXIMO } from './sombra';
import { montarPrompt, type EntradaMontador } from './montar-prompt';
import g3 from './__fixtures__/gabarito-3.json';

function entrada(): EntradaMontador {
  const e = g3.entrada as unknown as Omit<EntradaMontador, 'agora'> & { agora: string };
  return { ...e, agora: new Date(e.agora) };
}

const BLOCO = (nome: string, horario: string, resto = '') =>
  `texto fixo\n---\n\n<dados_usuario>\nNome: ${nome}\nTelefone: 5581900000000\nHorário: ${horario} (horário de Brasília)\n</dados_usuario>\n\n<dados_empresa>\nNome: E\n</dados_empresa>${resto}`;

describe('compararComN8n', () => {
  it('iguais byte a byte', () => {
    const p = BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52');
    const c = compararComN8n(p, p);
    expect(c).toEqual({
      igual: true,
      igualSemHorario: true,
      tamanhoMontado: p.length,
      tamanhoRecebido: p.length,
      primeiraDiferenca: null,
      trechoMontado: '',
      trechoRecebido: '',
    });
    expect(vereditoDe(c)).toBe('montador_igual');
  });

  it('só o horário muda: igualSemHorario, aponta a linha do horário', () => {
    const a = BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52');
    const b = BLOCO('Ana', 'sexta-feira, 23/10/2026 18:53');
    const c = compararComN8n(a, b);
    expect(c.igual).toBe(false);
    expect(c.igualSemHorario).toBe(true);
    expect(c.primeiraDiferenca).toBe(a.indexOf('18:52') + 4);
    expect(c.trechoMontado).toContain('18:52');
    expect(c.trechoRecebido).toContain('18:53');
    expect(vereditoDe(c)).toBe('montador_igual_sem_horario');
  });

  it('horário de tamanhos diferentes (virada de dia da semana) também é só horário', () => {
    const a = BLOCO('Ana', 'sábado, 24/10/2026 00:00');
    const b = BLOCO('Ana', 'sexta-feira, 23/10/2026 23:59');
    const c = compararComN8n(a, b);
    expect(c.igualSemHorario).toBe(true);
    expect(c.tamanhoMontado).not.toBe(c.tamanhoRecebido);
  });

  it('diferença real: não é igualSemHorario e aponta o texto, não o horário', () => {
    const a = BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52', '\nfim A');
    const b = BLOCO('Ana', 'sexta-feira, 23/10/2026 18:53', '\nfim B');
    const c = compararComN8n(a, b);
    expect(c.igual).toBe(false);
    expect(c.igualSemHorario).toBe(false);
    expect(c.primeiraDiferenca).toBe(a.indexOf('fim A') + 4);
    expect(c.trechoMontado.endsWith('fim A')).toBe(true);
    expect(c.trechoRecebido.endsWith('fim B')).toBe(true);
    expect(vereditoDe(c)).toBe('montador_diferente');
  });

  it('posição da diferença real vale em cada texto mesmo com horários de tamanho diferente', () => {
    const a = BLOCO('Ana', 'sábado, 24/10/2026 00:00', '\nXA');
    const b = BLOCO('Ana', 'segunda-feira, 26/10/2026 00:00', '\nXB');
    const c = compararComN8n(a, b);
    expect(c.igualSemHorario).toBe(false);
    expect(a[c.primeiraDiferenca as number]).toBe('A');
    // trecho do recebido é calculado na posição dele, não na do montado
    expect(c.trechoRecebido.endsWith('XB')).toBe(true);
    expect(c.trechoMontado.endsWith('XA')).toBe(true);
  });

  it('diferença antes do horário: posição igual nos dois textos', () => {
    const a = 'AAA' + BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52');
    const b = 'AAB' + BLOCO('Ana', 'sexta-feira, 23/10/2026 18:53');
    expect(compararComN8n(a, b).primeiraDiferenca).toBe(2);
  });

  it('um texto é prefixo do outro: a diferença começa onde o menor acaba', () => {
    const c = compararComN8n('abc', 'abcdef');
    expect(c.primeiraDiferenca).toBe(3);
    expect(c.trechoMontado).toBe('abc');
    expect(c.trechoRecebido).toBe('abcdef');
    expect(c.tamanhoMontado).toBe(3);
    expect(c.tamanhoRecebido).toBe(6);
  });

  it('sem o bloco <dados_usuario> não há o que normalizar: diferença é diferença', () => {
    const c = compararComN8n('um texto', 'um textO');
    expect(c.igualSemHorario).toBe(false);
    expect(c.primeiraDiferenca).toBe(7);
  });

  it('só olha o ÚLTIMO bloco <dados_usuario> (persona pode citar o bloco)', () => {
    const citacao = '\n<dados_usuario>\nNome: x\nTelefone: y\nHorário: HOJE (horário de Brasília)\n</dados_usuario>';
    const a = citacao + BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52');
    const b = citacao.replace('HOJE', 'AMANHÃ') + BLOCO('Ana', 'sexta-feira, 23/10/2026 18:52');
    expect(compararComN8n(a, b).igualSemHorario).toBe(false);
  });

  it('trechos têm no máximo 120 caracteres e cercam a diferença', () => {
    const a = 'x'.repeat(500) + 'AAA' + 'y'.repeat(500);
    const b = 'x'.repeat(500) + 'BBB' + 'y'.repeat(500);
    const c = compararComN8n(a, b);
    expect(c.primeiraDiferenca).toBe(500);
    expect(c.trechoMontado).toHaveLength(TRECHO_MAXIMO);
    expect(c.trechoRecebido).toHaveLength(TRECHO_MAXIMO);
    expect(c.trechoMontado).toContain('xAAAy');
    expect(c.trechoRecebido).toContain('xBBBy');
  });

  it('não deixa meio emoji nas pontas do trecho', () => {
    const a = '😀'.repeat(200) + 'A';
    const b = '😀'.repeat(200) + 'B';
    const c = compararComN8n(a, b);
    expect(c.trechoMontado.length).toBeLessThanOrEqual(TRECHO_MAXIMO);
    expect(/^[\uDC00-\uDFFF]/.test(c.trechoMontado)).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(c.trechoMontado)).toBe(false);
  });

  it('com um prompt montado de verdade: igual, depois só horário, depois mudança na persona', () => {
    const montado = montarPrompt(entrada());
    expect(compararComN8n(montado, montado).igual).toBe(true);

    const outroMinuto = montarPrompt({ ...entrada(), agora: new Date('2026-10-26T12:01:00.000Z') });
    const c1 = compararComN8n(montado, outroMinuto);
    expect(c1.igual).toBe(false);
    expect(c1.igualSemHorario).toBe(true);

    const e = entrada();
    const outraPersona = montarPrompt({ ...e, promptConfig: { ...e.promptConfig, system_prompt: 'OUTRA' } });
    const c2 = compararComN8n(montado, outraPersona);
    expect(c2.igualSemHorario).toBe(false);
    expect(montado.slice(c2.primeiraDiferenca as number, (c2.primeiraDiferenca as number) + 5)).not.toBe(
      outraPersona.slice(c2.primeiraDiferenca as number, (c2.primeiraDiferenca as number) + 5),
    );
  });
});

describe('mascararDadosDeCliente', () => {
  it('mantém o tamanho (as posições continuam valendo)', () => {
    const p = montarPrompt(entrada());
    expect(mascararDadosDeCliente(p)).toHaveLength(p.length);
  });

  it('nome do contato vira a forma, sem o conteúdo', () => {
    const m = mascararDadosDeCliente('<dados_usuario>\nNome: Maria da Silva 😘\nTelefone: 55\n');
    expect(m).toContain('Nome: Xxxxx xx Xxxxx 😘\n');
  });

  it('telefone (10+ dígitos, com ou sem pontuação) vira asteriscos; data e hora ficam', () => {
    const m = mascararDadosDeCliente('tel 5511999990000, (11) 99999-0000, +55 11 99999 0000, em 2026-10-24T15:00:00 e 23/10/2026 18:52, R$ 1.200');
    expect(m).toContain('tel *************');
    expect(m).toContain('(**) *****-****');
    expect(m).toContain('+** ** ***** ****');
    expect(m).toContain('2026-10-24T15:00:00');
    expect(m).toContain('23/10/2026 18:52');
    expect(m).toContain('R$ 1.200');
    expect(m).not.toMatch(/11999990000/);
  });

  it('intenções executadas e início da conversa viram forma; o texto fixo e a persona ficam legíveis', () => {
    const p = montarPrompt(entrada());
    const m = mascararDadosDeCliente(p);
    expect(m).not.toContain('Vc não teria vaga');
    expect(m).not.toContain('google_calendar_criar_evento');
    expect(m).toContain('[99:99] ✓ xxxxxx_xxxxxxxx_xxxxxx_xxxxxxx | xxxxxx=xxxx_xxxxxx');
    expect(m).toContain('- Xx xxx xxxxx xxxx xxx xx xx???');
    expect(m).toContain('Primeiras mensagens que este cliente enviou nesta conversa.');
    expect(m).toContain('Você é a Rita, atendente da Estúdio Exemplo');
  });

  it('os blocos vazios não quebram', () => {
    expect(mascararDadosDeCliente('<intents_executadas>\n\n</intents_executadas>')).toBe('<intents_executadas>\n\n</intents_executadas>');
  });

  it('o trecho do log não carrega nome nem mensagem do cliente quando a diferença cai nesses blocos', () => {
    const a = montarPrompt(entrada());
    const e = entrada();
    const b = montarPrompt({ ...e, inicioConversa: [{ content: 'Mensagem secreta do paciente' }], contatoNome: 'fulana de tal' });
    const c = compararComN8n(a, b);
    const tudo = c.trechoMontado + c.trechoRecebido;
    expect(tudo).not.toMatch(/fulana|Fulana|secreta|paciente|Ana Silva|Vc não/);
    expect(tudo).not.toMatch(/5543900000003/);
  });
});
