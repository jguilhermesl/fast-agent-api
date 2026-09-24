import { describe, it, expect } from 'vitest';
import { falaForaDoTurno, cumprimentoDeveCalar } from './saudacao-espera';
import type { MensagemDoCliente } from './cruzamento';

const CONV = '5e5976b0-0000-4000-8000-000000000000';
const t = (iso: string) => Date.parse(iso);

// Lead 5e5976b0, 24/09/2026 (UTC): "Boa tarde" 18:00:01, pergunta 18:00:13,
// turno do cumprimento começou ~18:00:15 e respondeu sozinho às 18:00:18.
const BOA_TARDE: MensagemDoCliente = { created_at: '2026-09-24T18:00:01.000Z', message_type: 'text', content: 'Boa tarde' };
const PERGUNTA: MensagemDoCliente = { created_at: '2026-09-24T18:00:13.000Z', message_type: 'text', content: 'A ultrassom de mama está quanto?' };
const INICIO = t('2026-09-24T18:00:15.000Z');

describe('falaForaDoTurno', () => {
  it('caso real: a pergunta chegou antes do turno começar e não está nele', () => {
    expect(falaForaDoTurno([BOA_TARDE, PERGUNTA], INICIO, 'Boa tarde')).toBe(true);
  });

  it('a própria mensagem do turno não conta', () => {
    expect(falaForaDoTurno([BOA_TARDE], INICIO, 'Boa tarde')).toBe(false);
  });

  it('as duas agrupadas no mesmo turno: nada fora', () => {
    expect(falaForaDoTurno([BOA_TARDE, PERGUNTA], INICIO, 'Boa tarde\nA ultrassom de mama está quanto?')).toBe(false);
  });

  it('qualquer mensagem depois do início conta, inclusive mídia', () => {
    const audio: MensagemDoCliente = { created_at: '2026-09-24T18:00:17.000Z', message_type: 'audio', content: '' };
    expect(falaForaDoTurno([BOA_TARDE, audio], INICIO, 'Boa tarde')).toBe(true);
  });

  it('mídia antes do início não conta: a do próprio turno chega sem texto', () => {
    const audio: MensagemDoCliente = { created_at: '2026-09-24T18:00:10.000Z', message_type: 'audio', content: '' };
    expect(falaForaDoTurno([audio], INICIO, 'oi')).toBe(false);
  });
});

describe('cumprimentoDeveCalar', () => {
  const semEspera = async () => {};

  it('cala na hora quando a pergunta já está na conversa, sem esperar', async () => {
    let esperou = false;
    const r = await cumprimentoDeveCalar(
      { getMensagensDoCliente: async () => [BOA_TARDE, PERGUNTA], esperar: async () => { esperou = true; }, agora: () => INICIO + 100 },
      { conversationId: CONV, inicioTurno: INICIO, clientMessages: 'Boa tarde', esperaMs: 5000 },
    );
    expect(r).toBe(true);
    expect(esperou).toBe(false);
  });

  it('espera e cala se a pergunta chega durante a espera', async () => {
    let chamada = 0;
    const r = await cumprimentoDeveCalar(
      {
        getMensagensDoCliente: async () => (++chamada === 1 ? [BOA_TARDE] : [BOA_TARDE, { ...PERGUNTA, created_at: '2026-09-24T18:00:17.000Z' }]),
        esperar: semEspera,
        agora: () => INICIO + 5000,
      },
      { conversationId: CONV, inicioTurno: INICIO, clientMessages: 'Boa tarde', esperaMs: 5000 },
    );
    expect(r).toBe(true);
    expect(chamada).toBe(2);
  });

  it('só "oi" e mais nada: responde normal', async () => {
    const r = await cumprimentoDeveCalar(
      { getMensagensDoCliente: async () => [{ ...BOA_TARDE, content: 'oi' }], esperar: semEspera },
      { conversationId: CONV, inicioTurno: INICIO, clientMessages: 'oi', esperaMs: 5000 },
    );
    expect(r).toBe(false);
  });

  it('erro de leitura não cala o turno (fail-open)', async () => {
    const r = await cumprimentoDeveCalar(
      { getMensagensDoCliente: async () => { throw new Error('timeout'); }, esperar: semEspera },
      { conversationId: CONV, inicioTurno: INICIO, clientMessages: 'Boa tarde' },
    );
    expect(r).toBe(false);
  });

  it('conversa da suíte (id não-UUID) nunca consulta', async () => {
    let consultou = false;
    const r = await cumprimentoDeveCalar(
      { getMensagensDoCliente: async () => { consultou = true; return [PERGUNTA]; }, esperar: semEspera },
      { conversationId: 'suite-abc', inicioTurno: INICIO, clientMessages: 'Boa tarde' },
    );
    expect(r).toBe(false);
    expect(consultou).toBe(false);
  });
});
