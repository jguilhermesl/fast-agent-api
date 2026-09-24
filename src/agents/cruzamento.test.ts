import { describe, it, expect, vi } from 'vitest';
import {
  janelaDeCruzamento,
  houveCruzamento,
  detectarCruzamento,
  comNotaDeCruzamento,
  NOTA_CRUZAMENTO,
  JANELA_CRUZAMENTO_MS,
  type DepsCruzamento,
  type RegistroTurno,
} from './cruzamento';

const ms = (iso: string) => new Date(iso).getTime();

// 79f78950, 24/09/2026 (UTC). Tempos do /api/chat tirados da execução 288973 do n8n.
const T1_79F: RegistroTurno = { inicio: ms('2026-09-24T16:39:34.770Z'), fim: ms('2026-09-24T16:39:59.088Z') };
const CONV_79F = '79f78950-fca1-4192-8835-ff63198b693d';
const PERGUNTA_DO_T1 = { created_at: '2026-09-24T16:39:20.468Z', message_type: 'text', content: 'Boa tarde. Gostaria de saber os valores dos exames ginecológicos' };
const E_QUAIS_VALORES = { created_at: '2026-09-24T16:39:54.191Z', message_type: 'text', content: 'E quais valores' };

describe('janelaDeCruzamento', () => {
  it('sem turno anterior não há o que cruzar', () => {
    expect(janelaDeCruzamento(null, Date.now())).toBeNull();
  });

  it('turno anterior velho demais não cruzou', () => {
    expect(janelaDeCruzamento(T1_79F, T1_79F.fim + JANELA_CRUZAMENTO_MS + 1)).toBeNull();
  });

  it('vai de 1 s antes do início a 2 s depois do fim do turno anterior', () => {
    expect(janelaDeCruzamento(T1_79F, ms('2026-09-24T16:40:10.440Z'))).toEqual({
      desde: T1_79F.inicio - 1_000,
      ate: T1_79F.fim + 2_000,
    });
  });
});

describe('houveCruzamento', () => {
  const janela = janelaDeCruzamento(T1_79F, ms('2026-09-24T16:40:10.440Z'))!;

  it('79f78950: "E quais valores" escrito enquanto o 1º turno montava a lista de combos', () => {
    expect(houveCruzamento([PERGUNTA_DO_T1, E_QUAIS_VALORES], janela)).toBe(true);
  });

  it('a fala que o próprio turno anterior respondeu não conta', () => {
    expect(houveCruzamento([PERGUNTA_DO_T1], janela)).toBe(false);
  });

  it('fala depois que a resposta chegou não é cruzamento', () => {
    const depois = { created_at: '2026-09-24T16:40:05.000Z', message_type: 'text', content: 'Ok' };
    expect(houveCruzamento([depois], janela)).toBe(false);
  });

  it('reação, edição, apagamento e evento do provedor em texto não são fala', () => {
    const t = '2026-09-24T16:39:50.000Z';
    expect(houveCruzamento([
      { created_at: t, message_type: 'reaction', content: '' },
      { created_at: t, message_type: 'edit', content: '' },
      { created_at: t, message_type: 'revoke', content: '' },
      { created_at: t, message_type: 'text', content: 'Unsupported message type: edit' },
      { created_at: t, message_type: 'text', content: '' },
    ], janela)).toBe(false);
  });

  it('imagem e áudio contam (a descrição/transcrição não fica em messages)', () => {
    const t = '2026-09-24T16:39:50.000Z';
    expect(houveCruzamento([{ created_at: t, message_type: 'image', content: '' }], janela)).toBe(true);
    expect(houveCruzamento([{ created_at: t, message_type: 'audio', content: null }], janela)).toBe(true);
  });

  it('2c7972e8: "❓" 4,7 s antes do fim do turno que respondia o pagamento', () => {
    const t1 = { inicio: ms('2026-09-23T10:22:51.024Z'), fim: ms('2026-09-23T10:23:01.396Z') };
    const j = janelaDeCruzamento(t1, ms('2026-09-23T10:23:11.872Z'))!;
    expect(houveCruzamento([{ created_at: '2026-09-23T10:22:56.673Z', message_type: 'text', content: '❓' }], j)).toBe(true);
  });
});

function deps(over: Partial<DepsCruzamento> = {}): DepsCruzamento {
  return {
    getUltimoTurno: vi.fn(async () => T1_79F),
    getMensagensDoCliente: vi.fn(async () => [PERGUNTA_DO_T1, E_QUAIS_VALORES]),
    agora: () => ms('2026-09-24T16:40:10.440Z'),
    ...over,
  };
}

describe('detectarCruzamento', () => {
  it('79f78950: marca "tempo" e consulta exatamente a janela [início − 1 s, fim + 2 s]', async () => {
    const d = deps();
    const r = await detectarCruzamento(d, { scopedClientId: 'x', conversationId: CONV_79F, esperouNaFila: false });

    expect(r).toBe('tempo');
    expect(d.getMensagensDoCliente).toHaveBeenCalledWith(
      CONV_79F,
      new Date(T1_79F.inicio - 1_000).toISOString(),
      new Date(T1_79F.fim + 2_000).toISOString(),
    );
  });

  it('turno que esperou na fila cruzou por definição — nem consulta', async () => {
    const d = deps();
    const r = await detectarCruzamento(d, { scopedClientId: 'x', conversationId: CONV_79F, esperouNaFila: true });

    expect(r).toBe('fila');
    expect(d.getUltimoTurno).not.toHaveBeenCalled();
    expect(d.getMensagensDoCliente).not.toHaveBeenCalled();
  });

  it('caso comum sem turno recente: nenhuma consulta ao Supabase', async () => {
    const d = deps({ getUltimoTurno: vi.fn(async () => null) });
    expect(await detectarCruzamento(d, { scopedClientId: 'x', conversationId: CONV_79F, esperouNaFila: false })).toBeNull();
    expect(d.getMensagensDoCliente).not.toHaveBeenCalled();
  });

  it('conversation_id de suíte ("suite-…", não UUID) não vai ao banco', async () => {
    const d = deps();
    expect(await detectarCruzamento(d, { scopedClientId: 'x', conversationId: 'suite-dac90331a0', esperouNaFila: false })).toBeNull();
    expect(d.getUltimoTurno).not.toHaveBeenCalled();
  });

  it('erro de leitura: sem aviso (fail-open), sem lançar', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ getMensagensDoCliente: vi.fn(async () => { throw new Error('timeout'); }) });
    expect(await detectarCruzamento(d, { scopedClientId: 'x', conversationId: CONV_79F, esperouNaFila: false })).toBeNull();
  });
});

describe('comNotaDeCruzamento', () => {
  it('põe o aviso antes da fala e mantém a fala intacta', () => {
    const r = comNotaDeCruzamento('E quais valores');
    expect(r.startsWith(NOTA_CRUZAMENTO)).toBe(true);
    expect(r.endsWith('\n\nE quais valores')).toBe(true);
  });
});
