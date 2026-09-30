import { describe, it, expect } from 'vitest';
import {
  decidirRajada,
  falasNovas,
  humanoNoTurno,
  ferramentaSemEfeito,
  juntarComPendente,
  ehConversaReal,
  LIMITE_DESCARTES_SEGUIDOS,
  PENDENTE_VALIDADE_MS,
  type EntradaRajada,
  type MensagemDaConversa,
} from './rajada';

const ms = (iso: string) => new Date(iso).getTime();
const inb = (created_at: string, content: string | null, message_type = 'text'): MensagemDaConversa => ({
  created_at, direction: 'inbound', message_type, content, sender_name: 'Cliente', from_device: false,
});
const ia = (created_at: string, content: string): MensagemDaConversa => ({
  created_at, direction: 'outbound', message_type: 'text', content, sender_name: null, from_device: false,
});
const equipe = (created_at: string, content: string, message_type = 'text'): MensagemDaConversa => ({
  created_at, direction: 'outbound', message_type, content, sender_name: 'Caio Vinicius', from_device: true,
});

// eca4d73c, Duda (BufferDelay 15 s), 30/09/2026 UTC. O lote "Qual o valor..." fechou
// às 19:08:09,5 e o turno entrou na API ~19:08:10. O "?" chegou 2,7 s depois; o
// 1º turno respondeu a ultrassom e, 6 s depois, o 2º repetiu "te passei acima".
const ECA_INICIO = ms('2026-09-30T19:08:10.000Z');
const ECA_MSGS = [
  inb('2026-09-30T19:07:31.235Z', 'Boa tarde'),
  ia('2026-09-30T19:07:53.136Z', 'Boa tarde! Sou a Duda da LP Saúde Rio Doce. O que você precisa hoje?'),
  inb('2026-09-30T19:07:55.493Z', 'Qual o valor da ultrassonografia pra grávida ?'),
  inb('2026-09-30T19:08:12.680Z', '?'),
];

function entrada(over: Partial<EntradaRajada> = {}): EntradaRajada {
  return {
    inicio: ECA_INICIO,
    agora: ECA_INICIO + 22_000,
    bufferDelayMs: 15_000,
    loteTexto: 'Qual o valor da ultrassonografia pra grávida ?',
    tools: ['conferir_especialidades', 'atualizar_lead_crm'],
    redirect: false,
    lockDesde: ECA_INICIO + 5,
    esperaMaxFilaMs: 30_000,
    descartesAnteriores: 0,
    inicioUltimoTurno: ms('2026-09-30T19:07:40.000Z'),
    lead: { handled_by: 'ai', status: 'open', ai_disabled: false },
    msgs: ECA_MSGS,
    ...over,
  };
}

describe('falasNovas', () => {
  it('eca4d73c: o "?" escrito durante o turno é novo, mesmo com "?" no fim do lote', () => {
    const novas = falasNovas(ECA_MSGS, { inicio: ECA_INICIO, bufferDelayMs: 15_000, loteTexto: 'Qual o valor da ultrassonografia pra grávida ?' });
    expect(novas.map((m) => m.content)).toEqual(['?']);
  });

  it('296f385b: corrida no fechamento do buffer — criada 2 s antes do turno, fora do lote', () => {
    // Lote [Sim, Sim, Psiquiatra] fechou ~12:41:18; a 4ª fala (12:41:16,2) entrou
    // no n8n depois do fechamento e virou outro turno.
    const inicio = ms('2026-09-29T12:41:18.300Z');
    const msgs = [
      inb('2026-09-29T12:40:47.060Z', 'Sim'),
      inb('2026-09-29T12:40:54.037Z', 'Sim'),
      inb('2026-09-29T12:41:03.996Z', 'Psiquiatra'),
      inb('2026-09-29T12:41:16.251Z', 'Aí eu queria fazer as duas consultas juntas'),
    ];
    const novas = falasNovas(msgs, { inicio, bufferDelayMs: 15_000, loteTexto: 'Sim\nSim\nPsiquiatra' });
    expect(novas.map((m) => m.content)).toEqual(['Aí eu queria fazer as duas consultas juntas']);
  });

  it('fala que já está no lote não é nova, mesmo criada depois da referência', () => {
    // Buffer fechado pela hora de uma mídia que entrou atrasada: leva junto um texto mais novo.
    const novas = falasNovas(
      [inb('2026-09-30T19:08:05.000Z', 'Quero  marcar\ncardiologista')],
      { inicio: ECA_INICIO, bufferDelayMs: 15_000, loteTexto: '[Imagem] pedido médico\nquero marcar\nCardiologista' },
    );
    expect(novas).toEqual([]);
  });

  it('texto criado antes da referência do buffer é do lote (ou de antes dele)', () => {
    // referência = início − 14 s + 1,5 s = 19:07:57,5
    const novas = falasNovas([inb('2026-09-30T19:07:57.000Z', 'outra coisa')], { inicio: ECA_INICIO, bufferDelayMs: 15_000, loteTexto: 'x' });
    expect(novas).toEqual([]);
  });

  it('mídia só conta se criada depois de início − 1 s (não dá para comparar com o lote)', () => {
    const lote = { inicio: ECA_INICIO, bufferDelayMs: 15_000, loteTexto: 'x' };
    expect(falasNovas([inb('2026-09-30T19:08:09.500Z', null, 'audio')], lote)).toHaveLength(1);
    expect(falasNovas([inb('2026-09-30T19:08:07.000Z', null, 'audio')], lote)).toHaveLength(0);
    expect(falasNovas([inb('2026-09-30T19:08:15.000Z', '', 'image')], lote)).toHaveLength(1);
  });

  it('reação, edição, apagamento, evento do provedor e mensagem da IA não contam', () => {
    const t = '2026-09-30T19:08:15.000Z';
    const novas = falasNovas([
      inb(t, '👍', 'reaction'),
      inb(t, '', 'edit'),
      inb(t, '', 'revoke'),
      inb(t, 'Unsupported message type: edit'),
      inb(t, '   '),
      inb(t, 'figurinha', 'sticker'),
      ia(t, 'resposta de outro turno'),
    ], { inicio: ECA_INICIO, bufferDelayMs: 15_000, loteTexto: 'x' });
    expect(novas).toEqual([]);
  });

  it('BufferDelay não lido: usa a folga curta (início − 1 s) também para texto', () => {
    const lote = { inicio: ECA_INICIO, bufferDelayMs: null, loteTexto: 'x' };
    expect(falasNovas([inb('2026-09-30T19:08:05.000Z', 'nova?')], lote)).toHaveLength(0);
    expect(falasNovas([inb('2026-09-30T19:08:09.500Z', 'nova?')], lote)).toHaveLength(1);
  });

  it('João (BufferDelay 3 s): a referência nunca passa de início − 1 s', () => {
    const lote = { inicio: ECA_INICIO, bufferDelayMs: 3_000, loteTexto: 'x' };
    expect(falasNovas([inb('2026-09-30T19:08:08.900Z', 'nova')], lote)).toHaveLength(0);
    expect(falasNovas([inb('2026-09-30T19:08:09.100Z', 'nova')], lote)).toHaveLength(1);
  });
});

describe('humanoNoTurno', () => {
  it('8de0184e: atendente escreveu pelo celular 0,3 s antes da resposta da IA', () => {
    const inicio = ms('2026-09-30T18:46:24.000Z');
    expect(humanoNoTurno([equipe('2026-09-30T18:46:40.833Z', 'Seria presencial ou online?')], inicio)).toBe(1);
  });

  it('não conta mensagem da IA, do sistema, reação nem fala antes do turno', () => {
    const inicio = ms('2026-09-30T18:46:24.000Z');
    expect(humanoNoTurno([
      ia('2026-09-30T18:46:30.000Z', 'x'),
      { ...equipe('2026-09-30T18:46:30.000Z', 'x'), sender_name: 'system' },
      equipe('2026-09-30T18:46:30.000Z', '👍', 'reaction'),
      equipe('2026-09-30T18:46:10.000Z', 'antes'),
    ], inicio)).toBe(0);
  });
});

describe('ferramentaSemEfeito', () => {
  it('consultas, busca e CRM podem rodar de novo', () => {
    for (const t of ['conferir_especialidades', 'conferir_combos', 'consultar_exames', 'atualizar_lead_crm', 'agent_knowledge_base', 'google_calendar_horarios_disponiveis', 'google_calendar_listar_eventos']) {
      expect(ferramentaSemEfeito(t)).toBe(true);
    }
  });

  it('agendar, texto fixo, arquivo, encerrar e cadastrar seguram a resposta', () => {
    for (const t of ['realizar_agendamento', 'consulta_agendada', 'enviar_detalhes_neurologia', 'enviar_protocolo', 'enviar_arquivo', 'encerrar_conversa', 'cadastrar_cliente', 'google_calendar_criar_evento', 'orcamento_solicitado']) {
      expect(ferramentaSemEfeito(t)).toBe(false);
    }
  });
});

describe('decidirRajada', () => {
  it('eca4d73c: fala nova durante o turno → descarta', () => {
    expect(decidirRajada(entrada())).toEqual({ acao: 'descartar', motivo: 'mensagem_nova', novas: 1, humano_no_turno: 0 });
  });

  it('sem fala nova → envia', () => {
    expect(decidirRajada(entrada({ msgs: ECA_MSGS.slice(0, 3) }))).toMatchObject({ acao: 'enviar', motivo: 'sem_mensagem_nova' });
  });

  it('transferência sempre sai', () => {
    expect(decidirRajada(entrada({ redirect: true }))).toMatchObject({ acao: 'enviar', motivo: 'transferencia' });
  });

  it('ferramenta com efeito (agendou, mandou texto fixo) sempre sai', () => {
    expect(decidirRajada(entrada({ tools: ['realizar_agendamento'] }))).toMatchObject({ acao: 'enviar', motivo: 'ferramenta_com_efeito' });
    expect(decidirRajada(entrada({ tools: ['conferir_especialidades', 'enviar_detalhes_neuropediatria'] }))).toMatchObject({ acao: 'enviar', motivo: 'ferramenta_com_efeito' });
  });

  it('atendente assumiu (handled_by ≠ ai): descarta para a memória não guardar o que não saiu', () => {
    expect(decidirRajada(entrada({ lead: { handled_by: 'human', status: 'open', ai_disabled: false }, msgs: [] })))
      .toMatchObject({ acao: 'descartar', motivo: 'lead_com_humano' });
  });

  it('lead em espera de humano ou com IA desligada: a fala nova não vira turno → envia', () => {
    expect(decidirRajada(entrada({ lead: { handled_by: 'ai', status: 'pending', ai_disabled: false } }))).toMatchObject({ acao: 'enviar', motivo: 'lead_sem_turno_novo' });
    expect(decidirRajada(entrada({ lead: { handled_by: 'ai', status: 'open', ai_disabled: true } }))).toMatchObject({ acao: 'enviar', motivo: 'lead_sem_turno_novo' });
  });

  it('leitura do lead falhou → envia (fail-open)', () => {
    expect(decidirRajada(entrada({ lead: null }))).toMatchObject({ acao: 'enviar', motivo: 'lead_ilegivel' });
  });

  it(`no máximo ${LIMITE_DESCARTES_SEGUIDOS} descartes seguidos na mesma rajada`, () => {
    expect(decidirRajada(entrada({ descartesAnteriores: 1 }))).toMatchObject({ acao: 'descartar' });
    expect(decidirRajada(entrada({ descartesAnteriores: 2 }))).toMatchObject({ acao: 'enviar', motivo: 'limite_de_descartes', novas: 1 });
  });

  it('sem lock da conversa não há garantia de que o próximo turno lê o pendente → envia', () => {
    expect(decidirRajada(entrada({ lockDesde: null }))).toMatchObject({ acao: 'enviar', motivo: 'sem_fila' });
    expect(decidirRajada(entrada({ esperaMaxFilaMs: 0 }))).toMatchObject({ acao: 'enviar', motivo: 'sem_fila' });
  });

  it('turno longo (o próximo pode ter desistido da fila) → envia', () => {
    expect(decidirRajada(entrada({ agora: ECA_INICIO + 27_500 }))).toMatchObject({ acao: 'enviar', motivo: 'turno_longo' });
    expect(decidirRajada(entrada({ agora: ECA_INICIO + 26_000 }))).toMatchObject({ acao: 'descartar' });
  });

  it('um turno mais novo já passou na frente pela fila → envia (ninguém leria o pendente)', () => {
    expect(decidirRajada(entrada({ inicioUltimoTurno: ECA_INICIO + 1_500 }))).toMatchObject({ acao: 'enviar', motivo: 'turno_mais_novo_ja_rodou' });
    expect(decidirRajada(entrada({ inicioUltimoTurno: null }))).toMatchObject({ acao: 'descartar' });
  });

  it('conta a fala da equipe no turno para o log, sem mudar a decisão', () => {
    const d = decidirRajada(entrada({ msgs: [...ECA_MSGS.slice(0, 3), equipe('2026-09-30T19:08:20.000Z', 'Oi')] }));
    expect(d).toEqual({ acao: 'enviar', motivo: 'sem_mensagem_nova', novas: 0, humano_no_turno: 1 });
  });
});

describe('juntarComPendente', () => {
  const agora = ms('2026-09-30T19:08:40.000Z');
  const pend = { texto: 'Qual o valor da ultrassonografia pra grávida ?', tipo: 'text' as const, em: agora - 15_000, descartes: 1 };

  it('mesmo tipo: junta como o buffer do n8n, na ordem em que o cliente escreveu', () => {
    expect(juntarComPendente(pend, { texto: '?', tipo: 'text' }, agora)).toEqual({
      texto: 'Qual o valor da ultrassonografia pra grávida ?\n?', tipo: 'text', juntou: true, descartes: 1,
    });
  });

  it('tipos diferentes: cada parte com o seu rótulo, turno vira texto', () => {
    const r = juntarComPendente({ ...pend, texto: 'minha menstruação não vem', tipo: 'audio_transcription' }, { texto: 'é normal?', tipo: 'text' }, agora);
    expect(r.tipo).toBe('text');
    expect(r.texto).toBe('[Áudio do cliente, transcrição automática] minha menstruação não vem\né normal?');
    const r2 = juntarComPendente(pend, { texto: 'pedido médico com USG obstétrica', tipo: 'image_analysis' }, agora);
    expect(r2.texto).toBe('Qual o valor da ultrassonografia pra grávida ?\n[Imagem enviada pelo cliente, descrição automática] pedido médico com USG obstétrica');
  });

  it('sem pendente, vazio ou vencido: turno segue como veio', () => {
    const atual = { texto: 'oi', tipo: 'text' as const };
    expect(juntarComPendente(null, atual, agora)).toEqual({ ...atual, juntou: false, descartes: 0 });
    expect(juntarComPendente({ ...pend, texto: '  ' }, atual, agora).juntou).toBe(false);
    expect(juntarComPendente({ ...pend, em: agora - PENDENTE_VALIDADE_MS - 1 }, atual, agora).juntou).toBe(false);
  });
});

describe('ehConversaReal', () => {
  it('suíte ("suite-…") não vai ao banco', () => {
    expect(ehConversaReal('suite-dac90331a0')).toBe(false);
    expect(ehConversaReal('eca4d73c-0000-4000-8000-000000000000')).toBe(true);
  });
});
