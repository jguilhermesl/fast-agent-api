import { describe, it, expect } from 'vitest';
import {
  marcadorMidia,
  lerMarcador,
  tipoPorExtensao,
  midiasAdiadas,
  intercalarMidias,
  paraHistorico,
} from './midia-no-fluxo';
import type { ToolCallLog } from '../types';

const FOTO1 = 'https://costaemuniz-crm.lovable.app/imoveis/cobertura-cabo-branco.jpg';
const FOTO2 = 'https://costaemuniz-crm.lovable.app/imoveis/cobertura-cabo-branco-3.jpg';

const adiado = (url: string): ToolCallLog => ({
  tool: 'enviar_arquivo',
  arguments: { file_url: url },
  result: { status: 'ok', http_status: 200, data: { success: true, adiado: true }, query_echo: { file_url: url } },
});

describe('marcador de mídia', () => {
  it('ida e volta: o marcador devolve a URL', () => {
    expect(lerMarcador(marcadorMidia(FOTO1))).toBe(FOTO1);
  });

  it('só vale a mensagem inteira: marcador no meio do texto não é mídia', () => {
    expect(lerMarcador(`Olha a foto ${marcadorMidia(FOTO1)}`)).toBeNull();
    expect(lerMarcador('Show! Separei umas fotos pra você.')).toBeNull();
  });

  it('aceita espaço em volta (o n8n pode deixar) e não aceita URL sem http', () => {
    expect(lerMarcador(`  ${marcadorMidia(FOTO1)} `)).toBe(FOTO1);
    expect(lerMarcador('[[midia:javascript:alert(1)]]')).toBeNull();
  });

  it.each([
    [FOTO1, 'image'],
    ['https://x.com/a.PNG?v=2', 'image'],
    ['https://x.com/v.mp4', 'video'],
    ['https://x.com/a.ogg', 'audio'],
    ['https://x.com/laudo.pdf', 'document'],
  ])('tipo de %s é %s', (url, tipo) => {
    expect(tipoPorExtensao(url)).toBe(tipo);
  });
});

describe('midiasAdiadas', () => {
  it('pega só enviar_arquivo adiado e com status ok, na ordem, sem repetir', () => {
    const tools: ToolCallLog[] = [
      { tool: 'atualizar_lead_crm', arguments: { stage: 'em-qualificacao' }, result: { status: 'ok' } },
      adiado(FOTO1),
      adiado(FOTO2),
      adiado(FOTO1),
    ];
    expect(midiasAdiadas(tools)).toEqual([FOTO1, FOTO2]);
  });

  it('foto que já saiu na hora (sem adiado) não volta para a resposta', () => {
    const naHora: ToolCallLog = {
      tool: 'enviar_arquivo',
      arguments: { file_url: FOTO1 },
      result: { status: 'ok', data: { ok: true, status: 'sent' } },
    };
    expect(midiasAdiadas([naHora])).toEqual([]);
  });

  it('erro no envio não vira mensagem', () => {
    const erro: ToolCallLog = { tool: 'enviar_arquivo', arguments: { file_url: FOTO1 }, result: { status: 'error' } };
    expect(midiasAdiadas([erro])).toEqual([]);
  });
});

describe('intercalarMidias', () => {
  it('acolhida → fotos → ficha', () => {
    const msgs = ['Show! Separei umas fotos da cobertura pra você.', 'Cobertura duplex em Cabo Branco\nValor: R$ 1.400.000\nÉ esse imóvel que te atende?'];
    expect(intercalarMidias(msgs, [FOTO1, FOTO2])).toEqual([
      msgs[0],
      marcadorMidia(FOTO1),
      marcadorMidia(FOTO2),
      msgs[1],
    ]);
  });

  it('primeira resposta com cumprimento, valor e ficha: fotos antes da ficha', () => {
    const msgs = ['Bom dia, Carlos, tudo bem? Aqui é a Canda.', 'O apartamento está anunciado por R$ 729.000.', 'Ficha'];
    expect(intercalarMidias(msgs, [FOTO1])).toEqual([msgs[0], msgs[1], marcadorMidia(FOTO1), msgs[2]]);
  });

  it('uma mensagem só, sem parágrafo: fotos depois dela', () => {
    expect(intercalarMidias(['Ficha'], [FOTO1])).toEqual(['Ficha', marcadorMidia(FOTO1)]);
  });

  it('uma mensagem só com acolhida e ficha (saída real da Canda, 05/10): fotos entre as duas', () => {
    const unica =
      'A Costa & Muniz tem assessoria de crédito, o corretor te ajuda nisso. Separei umas fotos da cobertura pra você.\n\n' +
      'Cobertura duplex em Cabo Branco\nBairro: Cabo Branco, 50 m da orla\nValor: R$ 1.400.000\n\nÉ esse imóvel que te atende?';
    expect(intercalarMidias([unica], [FOTO1, FOTO2])).toEqual([
      'A Costa & Muniz tem assessoria de crédito, o corretor te ajuda nisso. Separei umas fotos da cobertura pra você.',
      marcadorMidia(FOTO1),
      marcadorMidia(FOTO2),
      'Cobertura duplex em Cabo Branco\nBairro: Cabo Branco, 50 m da orla\nValor: R$ 1.400.000\n\nÉ esse imóvel que te atende?',
    ]);
  });

  it('abertura grudada na ficha (saída real da Canda, 05/10 20:27): cumprimento → abertura → fotos → ficha', () => {
    const msgs = [
      'Bom dia, Carlos, tudo bem? Aqui é a Canda, assistente virtual da Costa & Muniz.',
      'Separei umas fotos do apartamento pra você.\n\nApartamento novo a 2 quadras da praia, em Manaíra\nBairro: Manaíra, 400 m da praia\nValor: R$ 729.000\n\nÉ esse imóvel que te atende?',
    ];
    expect(intercalarMidias(msgs, [FOTO1, FOTO2])).toEqual([
      msgs[0],
      'Separei umas fotos do apartamento pra você.',
      marcadorMidia(FOTO1),
      marcadorMidia(FOTO2),
      'Apartamento novo a 2 quadras da praia, em Manaíra\nBairro: Manaíra, 400 m da praia\nValor: R$ 729.000\n\nÉ esse imóvel que te atende?',
    ]);
  });

  it('ficha que já abre a última mensagem não é cortada: fotos antes dela', () => {
    const msgs = ['Show! Separei umas fotos.', 'Cobertura duplex\nBairro: Cabo Branco\nValor: R$ 1.400.000\n\nÉ esse imóvel que te atende?'];
    expect(intercalarMidias(msgs, [FOTO1])).toEqual([msgs[0], marcadorMidia(FOTO1), msgs[1]]);
  });

  it('cumprimento + valor com ficha (saída real da Canda, 05/10): cumprimento → fotos → ficha', () => {
    const msgs = [
      'Bom dia, Carlos, tudo bem? Aqui é a Canda, assistente virtual da Costa & Muniz.',
      'O apartamento novo em Manaíra está anunciado por R$ 729.000.\nBairro: Manaíra\nValor: R$ 729.000\n\nÉ esse imóvel que te atende?',
    ];
    expect(intercalarMidias(msgs, [FOTO1])).toEqual([msgs[0], marcadorMidia(FOTO1), msgs[1]]);
  });

  it('sem texto: só as fotos', () => {
    expect(intercalarMidias([], [FOTO1])).toEqual([marcadorMidia(FOTO1)]);
  });

  it('sem fotos: não mexe', () => {
    const msgs = ['a', 'b'];
    expect(intercalarMidias(msgs, [])).toBe(msgs);
  });
});

describe('paraHistorico', () => {
  it('marcador vira [Imagem] e a URL não entra no histórico', () => {
    const texto = paraHistorico(['Show!', marcadorMidia(FOTO1), 'Ficha']);
    expect(texto).toBe('Show!\n[Imagem]\nFicha');
    expect(texto).not.toContain('https://');
  });
});
