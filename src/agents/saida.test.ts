import { describe, it, expect } from 'vitest';
import { parseOrchestratorOutput, entregouAoCliente, MENSAGEM_INSTABILIDADE } from './saida';

// Saídas cruas copiadas do log do Railway (`[Orchestrator] Saída não parseável:`),
// Duda, 13/09 a 24/09/2026. Todas viraram "instabilidade" + transferência.
const ARRAY_ABERTO = [
  String.raw`{"mensagens":["Entendi 😊\nSe o que tá te travando for o valor, a consulta pode ser no crédito sem juros.","redirect_human\": false,\n  \"transfer_reason\": null}`,
  String.raw`{"mensagens":["Pode sim 😊\nSe o que tá te travando for o valor, essa morfológica tem parcelamento sem juros no crédito.","redirect_human\": false,\n  \"transfer_reason\": null}`,
  String.raw`{"mensagens":["Entendi 😊 Se o que pesa agora é se organizar, o pagamento pode ser no crédito sem juros.","redirect_human\": false,\n  \"transfer_reason\": null}`,
];
const VAZIA_DEPOIS_DO_TEXTO_FIXO = '{"mensagens":[""],"redirect_human":false,"transfer_reason":null}';

const textoFixoOk = [{ tool: 'enviar_detalhes_neurologia', arguments: {}, result: { status: 'ok', data: { message: 'Workflow was started' } } }];
const textoFixoFalhou = [{ tool: 'enviar_detalhes_neurologia', arguments: {}, result: { status: 'error', http_status: 404 } }];
const soBusca = [{ tool: 'conferir_especialidades', arguments: { terms: 'ortopedista' }, result: { status: 'ok' } }];

describe('parseOrchestratorOutput — array que o modelo não fechou', () => {
  it('resgata a primeira mensagem, sem vazar o campo e sem transferir', () => {
    const r = parseOrchestratorOutput(ARRAY_ABERTO[0]);
    expect(r.mensagens).toEqual(['Entendi 😊\nSe o que tá te travando for o valor, a consulta pode ser no crédito sem juros.']);
    expect(r.redirect_human).toBe(false);
  });

  for (const raw of ARRAY_ABERTO) {
    it(`nenhum dos 3 casos reais vira instabilidade: ${raw.slice(15, 50)}…`, () => {
      const r = parseOrchestratorOutput(raw);
      expect(r.mensagens).toHaveLength(1);
      expect(r.mensagens[0]).not.toMatch(/redirect_human|transfer_reason/);
      expect(r.mensagens[0]).not.toBe(MENSAGEM_INSTABILIDADE);
      expect(r.redirect_human).toBe(false);
    });
  }

  it('pedido de transferência escapado dentro do array continua transferindo', () => {
    const raw = String.raw`{"mensagens":["Vou te passar para a equipe.","redirect_human\": true,\n  \"transfer_reason\": \"Cliente pediu humano\"}`;
    const r = parseOrchestratorOutput(raw);
    expect(r.mensagens).toEqual(['Vou te passar para a equipe.']);
    expect(r.redirect_human).toBe(true);
  });
});

describe('parseOrchestratorOutput — resposta vazia', () => {
  it('depois de texto fixo entregue, vazio é silêncio: sem mensagem e sem transferir', () => {
    const r = parseOrchestratorOutput(VAZIA_DEPOIS_DO_TEXTO_FIXO, true);
    expect(r).toEqual({ mensagens: [], redirect_human: false });
  });

  it('array vazio depois de texto fixo também é silêncio', () => {
    expect(parseOrchestratorOutput('{"mensagens":[],"redirect_human":false}', true).mensagens).toEqual([]);
  });

  it('sem nada entregue no turno, vazio segue transferindo — o cliente não pode ficar sem resposta', () => {
    const r = parseOrchestratorOutput(VAZIA_DEPOIS_DO_TEXTO_FIXO, false);
    expect(r.mensagens).toEqual([MENSAGEM_INSTABILIDADE]);
    expect(r.redirect_human).toBe(true);
    expect(r.transfer_reason).toBe('Resposta vazia do modelo');
  });

  it('vazio com redirect_human pedido transfere com o motivo do modelo, mesmo após texto fixo', () => {
    const r = parseOrchestratorOutput('{"mensagens":[""],"redirect_human":true,"transfer_reason":"Foto de requisição"}', true);
    expect(r.redirect_human).toBe(true);
    expect(r.transfer_reason).toBe('Foto de requisição');
    expect(r.mensagens).toHaveLength(1);
  });
});

describe('parseOrchestratorOutput — o que já funcionava continua igual', () => {
  it('JSON válido', () => {
    const r = parseOrchestratorOutput('{"mensagens":["Oi","Tudo bem?"],"redirect_human":false,"transfer_reason":null}');
    expect(r).toEqual({ mensagens: ['Oi', 'Tudo bem?'], redirect_human: false, transfer_reason: undefined });
  });

  it('JSON dentro de cerca de código', () => {
    const r = parseOrchestratorOutput('```json\n{"mensagens":["Oi"],"redirect_human":false}\n```');
    expect(r.mensagens).toEqual(['Oi']);
  });

  it('JSON duplo-codificado não vaza para o cliente (08 e 10/08/2026)', () => {
    const r = parseOrchestratorOutput('{"mensagens":["{\\"mensagens\\":[\\"Perfeito\\"]}"],"redirect_human":false}');
    expect(r.mensagens.join(' ')).not.toMatch(/"mensagens"/);
  });

  it('texto puro que começa com colchete vai como texto', () => {
    const r = parseOrchestratorOutput('[IMPORTANTE] chegue 15 min antes');
    expect(r).toEqual({ mensagens: ['[IMPORTANTE] chegue 15 min antes'], redirect_human: false });
  });

  it('saída totalmente vazia segue transferindo', () => {
    const r = parseOrchestratorOutput('');
    expect(r.redirect_human).toBe(true);
    expect(r.transfer_reason).toBe('Saída do modelo não parseável');
  });

  it('JSON quebrado com o array fechado segue resgatado, com motivo de transferência', () => {
    const raw = '{"mensagens":["Já te passo para a equipe."],"redirect_human":true,"transfer_reason":"Cliente pediu humano",}}';
    const r = parseOrchestratorOutput(raw);
    expect(r.mensagens).toEqual(['Já te passo para a equipe.']);
    expect(r.redirect_human).toBe(true);
    expect(r.transfer_reason).toBe('Cliente pediu humano');
  });
});

describe('entregouAoCliente', () => {
  it('texto fixo com sucesso conta', () => expect(entregouAoCliente(textoFixoOk)).toBe(true));
  it('texto fixo que falhou não conta', () => expect(entregouAoCliente(textoFixoFalhou)).toBe(false));
  it('busca não conta', () => expect(entregouAoCliente(soBusca)).toBe(false));
  it('nenhuma ferramenta não conta', () => expect(entregouAoCliente([])).toBe(false));
});
