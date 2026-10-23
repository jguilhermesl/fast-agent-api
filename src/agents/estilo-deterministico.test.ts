import { describe, it, expect } from 'vitest';
import { aplicarEstilo, lerEstilo, MAX_BALOES } from './estilo-deterministico';

// Caracteres invisíveis e sequências montados por código ponto, para o arquivo não depender
// de como o editor grava FE0F, ZWJ e tags.
const cp = (...c: number[]) => String.fromCodePoint(...c);
const FE0F = cp(0xfe0f);
const CORACAO = cp(0x2764, 0xfe0f); // ❤️
const KEYCAP_1 = `1${FE0F}${cp(0x20e3)}`; // 1️⃣
const BANDEIRA_BR = cp(0x1f1e7, 0x1f1f7);
const JOINHA_TOM = cp(0x1f44d, 0x1f3fd); // 👍🏽
const FAMILIA = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // 👨‍👩‍👧
const BANDEIRA_INGLATERRA = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);

const MIDIA = '[[midia:https://cdn.exemplo.com/fotos/sala.jpg]]';
const MIDIA_2 = '[[midia:https://cdn.exemplo.com/fotos/quarto.jpg?v=2]]';

const SEM_EMOJI = { emoji: false } as const;

describe('aplicarEstilo: sem a chave nada muda', () => {
  const msgs = ['Olá 😀 tudo bem?\n\nSegue **valor**: R$ 150,00', '[[midia:https://x.com/a.jpg]]', '🙏'];

  it('estilo ausente devolve o mesmo array, byte a byte', () => {
    const r = aplicarEstilo(msgs);
    expect(r.mensagens).toBe(msgs);
    expect(r.mudancas).toEqual({ emojisRemovidos: 0, baloesAntes: 3, baloesDepois: 3, negritoConvertido: 0 });
  });

  it('estilo null também não mexe', () => {
    expect(aplicarEstilo(msgs, null).mensagens).toBe(msgs);
  });

  it('{ emoji: true } não tira emoji nem divide', () => {
    const r = aplicarEstilo(['Olá 😀\n\nTudo bem? 👍'], { emoji: true });
    expect(r.mensagens).toEqual(['Olá 😀\n\nTudo bem? 👍']);
    expect(r.mudancas.emojisRemovidos).toBe(0);
  });

  it('chave presente e vazia ({}) só converte o negrito', () => {
    const r = aplicarEstilo(['Olá 😀\n\nTem **desconto** hoje'], {});
    expect(r.mensagens).toEqual(['Olá 😀\n\nTem *desconto* hoje']);
    expect(r.mudancas).toEqual({ emojisRemovidos: 0, baloesAntes: 1, baloesDepois: 1, negritoConvertido: 1 });
  });

  it('lista vazia fica vazia', () => {
    expect(aplicarEstilo([], SEM_EMOJI).mensagens).toEqual([]);
  });
});

describe('aplicarEstilo: emoji', () => {
  it('tira emoji só de parte das mensagens e arruma o espaço', () => {
    const r = aplicarEstilo(['Olá 😀 tudo bem? 👍', 'Sem emoji aqui.', 'Pode me contar mais 😊.'], SEM_EMOJI);
    expect(r.mensagens).toEqual(['Olá tudo bem?', 'Sem emoji aqui.', 'Pode me contar mais.']);
    expect(r.mudancas).toEqual({ emojisRemovidos: 3, baloesAntes: 3, baloesDepois: 3, negritoConvertido: 0 });
  });

  it('espaço antes de pontuação e espaço duplo somem', () => {
    expect(aplicarEstilo(['Olá 😀!', 'Combinado 🙏, até lá', 'Feito  😀  ok'], SEM_EMOJI).mensagens).toEqual([
      'Olá!',
      'Combinado, até lá',
      'Feito ok',
    ]);
  });

  it('emoji colado na palavra não cola as palavras', () => {
    expect(aplicarEstilo(['Olá😀tudo', 'Fim!😀'], SEM_EMOJI).mensagens).toEqual(['Olá tudo', 'Fim!']);
  });

  it('emoji no começo da linha, em lista e em negrito', () => {
    const r = aplicarEstilo(['😀 Olá!\n✅ Item um\n- 👍 Item dois\n**✅ Pronto**\n**Aviso ⚠️**'], SEM_EMOJI);
    // sem espaço sobrando dentro do negrito: "*Pronto*", não "* Pronto*" nem "*Aviso *"
    expect(r.mensagens).toEqual(['Olá!\nItem um\n- Item dois\n*Pronto*\n*Aviso*']);
  });

  it('linha só de emoji entre parágrafos some sem deixar buraco', () => {
    expect(aplicarEstilo(['a\n\n😀\n\nb'], SEM_EMOJI).mensagens).toEqual(['a\n\nb']);
  });

  it('mensagem que só tinha emoji some do turno', () => {
    const r = aplicarEstilo(['Oi 😀', '👍', 'Tudo bem?'], SEM_EMOJI);
    expect(r.mensagens).toEqual(['Oi', 'Tudo bem?']);
    expect(r.mudancas).toMatchObject({ emojisRemovidos: 2, baloesAntes: 3, baloesDepois: 2 });
    expect(r.mudancas.restaurouOriginais).toBeUndefined();
  });

  it('todas as mensagens só de emoji: devolve as originais e avisa', () => {
    const original = ['😀', '👍👍', ' 🙏 '];
    const r = aplicarEstilo(original, SEM_EMOJI);
    expect(r.mensagens).toBe(original);
    expect(r.mudancas).toEqual({
      emojisRemovidos: 0,
      baloesAntes: 3,
      baloesDepois: 3,
      negritoConvertido: 0,
      restaurouOriginais: true,
    });
  });

  it('só emoji + mídia: o texto não some, volta tudo como estava', () => {
    const original = ['😀', MIDIA];
    const r = aplicarEstilo(original, SEM_EMOJI);
    expect(r.mensagens).toBe(original);
    expect(r.mudancas.restaurouOriginais).toBe(true);
  });

  it('bandeira, tom de pele, ZWJ, variação, keycap e bandeira de região', () => {
    const r = aplicarEstilo(
      [
        `${BANDEIRA_BR} Brasil`,
        `Joia ${JOINHA_TOM} feito`,
        `Família ${FAMILIA} reunida`,
        `Amo ${CORACAO} isso`,
        `${KEYCAP_1} primeiro passo`,
        `Reino ${BANDEIRA_INGLATERRA} Unido`,
      ],
      SEM_EMOJI,
    );
    expect(r.mensagens).toEqual(['Brasil', 'Joia feito', 'Família reunida', 'Amo isso', '1. primeiro passo', 'Reino Unido']);
    expect(r.mudancas.emojisRemovidos).toBe(6);
    // nada de resto invisível (FE0F, ZWJ, keycap, tag, tom de pele)
    expect(r.mensagens.join('')).toMatch(/^[\p{L}\p{N}\s.]+$/u);
  });

  it('keycap numérico deixa o número: menu numerado continua numerado', () => {
    const k = (d: string) => `${d}${FE0F}${cp(0x20e3)}`;
    const menu = `${k('1')} Consulta\n${k('2')} Retorno\n  ${k('3')} Exame`;
    const r = aplicarEstilo([menu, `Responda ${k('1')} ou ${k('2')}, ou #${FE0F}${cp(0x20e3)} para sair`], SEM_EMOJI);
    expect(r.mensagens).toEqual(['1. Consulta\n2. Retorno\n  3. Exame', 'Responda 1 ou 2, ou para sair']);
    expect(r.mudancas.emojisRemovidos).toBe(6);
  });

  it('resto invisível de emoji (FE0F solto) também sai', () => {
    expect(aplicarEstilo([`ok${FE0F} feito`], SEM_EMOJI).mensagens).toEqual(['ok feito']);
  });

  it('símbolos que não são pictográficos ficam: ✓ ★ → © ® ™ • –', () => {
    const texto = '✓ pronto ★ veja → © 2026 Marca® e Produto™ • item – fim';
    expect(aplicarEstilo([texto], SEM_EMOJI).mensagens).toEqual([texto]);
  });
});

describe('aplicarEstilo: não estraga o resto do texto', () => {
  it('valor em reais, data e hora ficam intactos', () => {
    const texto = 'Consulta: R$ 150,00 (Pix R$ 135,00) em 12/10/2026 às 14:30, com o Dr. Edson.';
    expect(aplicarEstilo([texto], SEM_EMOJI).mensagens).toEqual([texto]);
    expect(aplicarEstilo([`${texto} 😀`], SEM_EMOJI).mensagens).toEqual([texto]);
    expect(aplicarEstilo([texto], { emoji: false, dividir: true }).mensagens).toEqual([texto]);
  });

  it('lista com hífen fica numa mensagem só e intacta', () => {
    const lista = 'Opções:\n- Segunda, 08:00\n- Terça, 10:30\n- Quarta, 15:00';
    expect(aplicarEstilo([lista], { emoji: false, dividir: true }).mensagens).toEqual([lista]);
  });

  it('lista com hífen e emoji só perde o emoji', () => {
    expect(aplicarEstilo(['Opções:\n- 📅 Segunda, 08:00\n- 📅 Terça, 10:30'], SEM_EMOJI).mensagens).toEqual([
      'Opções:\n- Segunda, 08:00\n- Terça, 10:30',
    ]);
  });

  it('indentação de linha que não tinha emoji é preservada', () => {
    const t = 'Itens:\n  - um\n  - dois 😀\n    - sub';
    expect(aplicarEstilo([t], SEM_EMOJI).mensagens).toEqual(['Itens:\n  - um\n  - dois\n    - sub']);
  });
});

describe('aplicarEstilo: URLs não são tocadas', () => {
  const url = 'https://exemplo.com/a_b*c/**d**/e?x=1&y=%F0%9F%98%80&z=a+b#frag_(1)';

  it('URL com caracteres especiais sai igual', () => {
    const r = aplicarEstilo([`Veja ${url} 😀 e me diga.`], { emoji: false, dividir: true });
    expect(r.mensagens).toEqual([`Veja ${url} e me diga.`]);
    expect(r.mudancas.negritoConvertido).toBe(0);
  });

  it('URL no fim da frase com ponto e emoji colado', () => {
    expect(aplicarEstilo([`Acesse https://exemplo.com/x.😀`], SEM_EMOJI).mensagens).toEqual(['Acesse https://exemplo.com/x.']);
    expect(aplicarEstilo([`Acesse https://exemplo.com/x😀`], SEM_EMOJI).mensagens).toEqual(['Acesse https://exemplo.com/x']);
  });

  it('negrito em volta da URL converte, o miolo da URL não', () => {
    expect(aplicarEstilo([`**${url}**`], {}).mensagens).toEqual([`*${url}*`]);
  });

  it('www e link de imóvel com emoji ao redor', () => {
    const t = '🏠 Casa 3 quartos 👉 www.exemplo.com.br/site/imovel/ABC-123?utm=a_b 😀';
    expect(aplicarEstilo([t], SEM_EMOJI).mensagens).toEqual(['Casa 3 quartos www.exemplo.com.br/site/imovel/ABC-123?utm=a_b']);
  });
});

describe('aplicarEstilo: negrito', () => {
  it('**texto** vira *texto*', () => {
    const r = aplicarEstilo(['**Olá**, tudo bem? **Nome:** Fulano e **duas palavras**.'], {});
    expect(r.mensagens).toEqual(['*Olá*, tudo bem? *Nome:* Fulano e *duas palavras*.']);
    expect(r.mudancas.negritoConvertido).toBe(3);
  });

  it('*texto* simples, itálico e asteriscos soltos ficam', () => {
    const t = 'Já é *negrito* aqui, _itálico_ ali, 2 * 3 = 6 e ** solto ** também.';
    const r = aplicarEstilo([t], {});
    expect(r.mensagens).toEqual([t]);
    expect(r.mudancas.negritoConvertido).toBe(0);
  });

  it('*** e **texto** em linhas diferentes não viram negrito torto', () => {
    const t = '***forte***\n**linha um\nlinha dois**';
    expect(aplicarEstilo([t], {}).mensagens).toEqual([t]);
  });

  it('não mexe em mensagem de mídia', () => {
    expect(aplicarEstilo(['**a**', '[[midia:https://x.com/**a**.jpg]]'], {}).mensagens).toEqual(['*a*', '[[midia:https://x.com/**a**.jpg]]']);
  });

  it('emoji dentro do negrito sai e o negrito converte', () => {
    expect(aplicarEstilo(['**😀 Olá**'], SEM_EMOJI).mensagens).toEqual(['*Olá*']);
  });
});

describe('aplicarEstilo: dividir', () => {
  it('2 parágrafos viram 2 balões na ordem', () => {
    const r = aplicarEstilo(['Primeiro parágrafo.\n\nSegundo parágrafo?'], { dividir: true });
    expect(r.mensagens).toEqual(['Primeiro parágrafo.', 'Segundo parágrafo?']);
    expect(r.mudancas).toMatchObject({ baloesAntes: 1, baloesDepois: 2 });
  });

  it('linha em branco com espaço e várias linhas em branco também separam', () => {
    expect(aplicarEstilo(['a\n \n\n\nb\r\n\r\nc'], { dividir: true }).mensagens).toEqual(['a', 'b', 'c']);
  });

  it('5 parágrafos: teto de 4, o excedente cola no último com linha em branco', () => {
    expect(MAX_BALOES).toBe(4);
    const r = aplicarEstilo(['p1\n\np2\n\np3\n\np4\n\np5'], { dividir: true });
    expect(r.mensagens).toEqual(['p1', 'p2', 'p3', 'p4\n\np5']);
    expect(r.mudancas).toMatchObject({ baloesAntes: 1, baloesDepois: 4 });
  });

  it('o teto vale para o turno todo, não por mensagem', () => {
    const r = aplicarEstilo(['a\n\nb', 'c\n\nd', 'e', 'f'], { dividir: true });
    expect(r.mensagens).toEqual(['a', 'b', 'c', 'd\n\ne\n\nf']);
  });

  it('mensagem sem linha em branco fica como veio (quebra de linha simples não divide)', () => {
    const t = 'linha um\nlinha dois\nlinha três';
    expect(aplicarEstilo([t], { dividir: true }).mensagens).toEqual([t]);
  });

  it('dividir ausente não divide nem junta', () => {
    const msgs = ['a\n\nb', 'c'];
    expect(aplicarEstilo(msgs, SEM_EMOJI).mensagens).toEqual(msgs);
  });

  it('emoji sai antes de dividir: parágrafo só de emoji não vira balão', () => {
    expect(aplicarEstilo(['Oi!\n\n😀\n\nTudo bem?'], { emoji: false, dividir: true }).mensagens).toEqual(['Oi!', 'Tudo bem?']);
  });
});

describe('aplicarEstilo: juntar (dividir: false)', () => {
  it('junta as mensagens de texto do turno em uma, com linha em branco entre elas', () => {
    const r = aplicarEstilo(['Olá!', 'Tudo bem?\n\nPosso ajudar?', 'Me conta.'], { dividir: false });
    expect(r.mensagens).toEqual(['Olá!\n\nTudo bem?\n\nPosso ajudar?\n\nMe conta.']);
    expect(r.mudancas).toMatchObject({ baloesAntes: 3, baloesDepois: 1 });
  });

  it('uma mensagem só fica como está', () => {
    expect(aplicarEstilo(['Olá!\n\nTudo bem?'], { dividir: false }).mensagens).toEqual(['Olá!\n\nTudo bem?']);
  });

  it('junta depois de tirar emoji', () => {
    expect(aplicarEstilo(['Olá 😀', '👍', 'Tudo bem?'], { emoji: false, dividir: false }).mensagens).toEqual(['Olá\n\nTudo bem?']);
  });
});

describe('aplicarEstilo: mídia no meio', () => {
  it('dividir: true divide o texto e mantém a mídia no lugar', () => {
    const r = aplicarEstilo(['Separei umas fotos.\n\nSegue a ficha:', MIDIA, 'Cobertura, 3 quartos\n\nQuer ver pessoalmente?'], { dividir: true });
    expect(r.mensagens).toEqual(['Separei umas fotos.', 'Segue a ficha:', MIDIA, 'Cobertura, 3 quartos', 'Quer ver pessoalmente?']);
    expect(r.mudancas).toMatchObject({ baloesAntes: 3, baloesDepois: 5 });
  });

  it('dividir: false junta só o texto seguido; a mídia fica onde estava', () => {
    const r = aplicarEstilo(['Aqui', 'estão', MIDIA, 'a ficha', 'e a pergunta', MIDIA_2], { dividir: false });
    expect(r.mensagens).toEqual(['Aqui\n\nestão', MIDIA, 'a ficha\n\ne a pergunta', MIDIA_2]);
  });

  it('mídia nunca é colada em texto, no começo, no meio ou no fim', () => {
    const r = aplicarEstilo([MIDIA, 'a', 'b', MIDIA_2, 'c'], { dividir: false });
    expect(r.mensagens).toEqual([MIDIA, 'a\n\nb', MIDIA_2, 'c']);
  });

  it('teto de 4 não manda texto de depois da mídia para antes dela', () => {
    const r = aplicarEstilo(['t1', 't2', 't3', 't4', MIDIA, 't5', 't6'], { dividir: true });
    expect(r.mensagens).toEqual(['t1', 't2', 't3', 't4', MIDIA, 't5\n\nt6']);
  });

  it('marcador de mídia fica byte a byte, mesmo com emoji ou espaço em volta', () => {
    const marcador = '  [[midia:https://cdn.exemplo.com/a%20b/foto😀.jpg?x=1&y=*2]]  ';
    const r = aplicarEstilo(['Olá 😀', marcador, 'Tchau'], { emoji: false, dividir: true });
    expect(r.mensagens).toEqual(['Olá', marcador, 'Tchau']);
  });

  it('mídia com texto só de emoji: a mídia segue e o texto vazio some', () => {
    const r = aplicarEstilo(['😀', MIDIA, 'Quer ver?'], SEM_EMOJI);
    expect(r.mensagens).toEqual([MIDIA, 'Quer ver?']);
  });
});

describe('lerEstilo', () => {
  it('objeto com booleanos vale', () => {
    expect(lerEstilo({ emoji: false, dividir: true })).toEqual({ emoji: false, dividir: true });
    expect(lerEstilo({ emoji: true })).toEqual({ emoji: true });
  });

  it('objeto vazio ainda é "chave presente"', () => {
    expect(lerEstilo({})).toEqual({});
  });

  it('campo que não é booleano é ignorado', () => {
    expect(lerEstilo({ emoji: 'false', dividir: 1 })).toEqual({});
  });

  it('ausente, null, texto, número e array = sem estilo', () => {
    for (const v of [undefined, null, 'x', 1, true, [], [{ emoji: false }]]) expect(lerEstilo(v)).toBeUndefined();
  });
});
