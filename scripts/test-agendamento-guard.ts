// ============================================================
// Teste do guard de agendamento — funções puras, sem rede
// ============================================================
//
//   npx tsx scripts/test-agendamento-guard.ts
//
// Os casos vêm de mensagens reais da produção (Leandro, Duda, Dani), incluindo
// as que fizeram uma medição anterior contar falso positivo.

import {
  afirmaAgendamento,
  extrairDataHora,
  criouEventoNesteTurno,
  slotsOferecidos,
  mensagemDeReoferta,
  garantirAgendamento,
  SLUG_CRIACAO_RE,
} from '../src/agents/agendamento-guard';
import type { AgentIntent, IntentLog, ToolCallLog } from '../src/types';

let passou = 0;
let falhou = 0;

function check(nome: string, real: unknown, esperado: unknown) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (ok) {
    passou++;
    console.log(`  ok   ${nome}`);
  } else {
    falhou++;
    console.log(`  FALHA ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        real:     ${JSON.stringify(real)}`);
  }
}

// ── 1. Detecção de confirmação ───────────────────────────────

console.log('\n[1] afirmaAgendamento — deve DETECTAR (confirmação real ao cliente)');

check('caso real Leandro 20/08 (lead 58c7d6fc)',
  afirmaAgendamento(['Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.', 'Pode vir com roupa leve.']), true);
check('Duda — "Agendamento confirmado ✅"',
  afirmaAgendamento(['Agendamento confirmado ✅', '• Paciente: Charles', '• Data: 22/08/2026', '• Horário: 09h']), true);
check('"está agendado para"',
  afirmaAgendamento(['Prontinho, está agendado para sexta, 21/08 às 14h.']), true);
check('"te espero quinta"',
  afirmaAgendamento(['Te espero quinta, 20/08 às 12h em Ibiporã!']), true);
check('"reservei o seu horário"',
  afirmaAgendamento(['Reservei o seu horário de amanhã às 10h. 😊']), true);
check('"sua consulta foi marcada"',
  afirmaAgendamento(['Pronto! Sua consulta foi marcada para 25/08 às 11h.']), true);

console.log('\n[2] afirmaAgendamento — NÃO pode detectar');

check('proposta ainda em aberto (prompt do Leandro, Passo 2)',
  afirmaAgendamento(['Perfeito! A avaliação completa fica R$ 190,00. Posso confirmar esse horário pra você?']), false);
check('oferta de horários',
  afirmaAgendamento(['Consigo hoje, quinta 20/08 às 12h em Ibiporã ou amanhã, sexta 21/08 às 12h em Londrina. Qual fica melhor?']), false);
check('"quer que eu agende?"',
  afirmaAgendamento(['Quer que eu agende pra quinta às 12h?']), false);
check('notificação interna da Dani (LP Saúde)',
  afirmaAgendamento(['✅ Atenção: Agendamento confirmado no whatsapp da LP Saúde ✅.\n\nNome do cliente: Charles Bernardo\nData de agendamento: 22/08/2026']), false);
check('notificação "CONSULTA AGENDADA" para o grupo',
  afirmaAgendamento(['✅ *CONSULTA AGENDADA* ✅\n\n👤 *Cliente:* Leandro Muller\n📱 *WhatsApp:* 4384313528']), false);
check('transferência de atendimento',
  afirmaAgendamento(['⚠️ *TRANSFERÊNCIA DE ATENDIMENTO* ⚠️\n\n👤 *Cliente:* Vanessa\n📋 *Motivo:* não há agendamento confirmado']), false);
check('log de sistema "Conversa encerrada"',
  afirmaAgendamento(['Conversa encerrada: Cliente satisfeito após agendamento confirmado']), false);
check('saudação',
  afirmaAgendamento(['Olá! Sou o Leandro da Quiroleve 😊', 'Me conta onde está a dor.']), false);
check('vazio',
  afirmaAgendamento([]), false);

// Falsos positivos pescados no replay dos 30 dias — cada um custou uma regra.
console.log('\n[2b] afirmaAgendamento — falsos positivos vindos do tráfego real');

check('Duda 02/08 — proposta condicional "ela fica reservada"',
  afirmaAgendamento(['Posso já garantir sua vaga de sábado às 09h para você não ficar sem atendimento, e se conseguir se organizar, ela fica reservada.']), false);
check('Duda — negação "ainda não ficou confirmado"',
  afirmaAgendamento(['Recebi os dados do paciente, mas o agendamento ainda não ficou confirmado neste momento.']), false);
check('Duda — negação "não apareceu nenhuma confirmação"',
  afirmaAgendamento(['Pelo que tenho aqui na conversa, não apareceu nenhuma confirmação de que a consulta já ficou marcada.']), false);
check('Duda — referência a agendamento anterior ("já ficou marcada")',
  afirmaAgendamento(['Sua consulta já ficou marcada para o turno da tarde com clínico geral.']), false);
check('Duda — política de atendimento por ordem de chegada',
  afirmaAgendamento(['Sobre o atendimento: sua vaga fica marcada para esse horário, mas o atendimento na clínica é por ordem de chegada.']), false);
check('Duda — pedido de dado que falta',
  afirmaAgendamento(['Para deixar o agendamento confirmado, me envia por favor o nome e sobrenome da paciente.']), false);
check('Leandro — "posso deixar um horário reservado sem compromisso"',
  afirmaAgendamento(['Se quiser, posso deixar um horário reservado pra você sem compromisso.']), false);

// ── 3. Extração de data e hora ───────────────────────────────

console.log('\n[3] extrairDataHora');

const AGORA = new Date('2026-08-20T13:00:00Z'); // 10h em São Paulo

check('caso real — "quinta, 20/08 às 12h em Ibiporã"',
  extrairDataHora(['Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.', 'Pode vir com roupa leve.'], AGORA),
  { iso: '2026-08-20T12:00:00', unidade: 'Ibiporã' });
check('data com ano — "22/08/2026 às 09h"',
  extrairDataHora(['Agendamento confirmado ✅ Data: 22/08/2026 Horário: 09h'], AGORA)?.iso, '2026-08-22T09:00:00');
check('hora com minuto — "14:30"',
  extrairDataHora(['Está agendado para 21/08 às 14:30.'], AGORA)?.iso, '2026-08-21T14:30:00');
check('"12h30"',
  extrairDataHora(['Seu horário ficou para 20/08 às 12h30.'], AGORA)?.iso, '2026-08-20T12:30:00');
check('"hoje às 16h"',
  extrairDataHora(['Seu horário ficou para hoje às 16h.'], AGORA)?.iso, '2026-08-20T16:00:00');
check('"amanhã às 9 horas"',
  extrairDataHora(['Reservei o seu horário de amanhã às 9 horas.'], AGORA)?.iso, '2026-08-21T09:00:00');
check('dia da semana sem data — "sexta às 14h"',
  extrairDataHora(['Te espero sexta às 14h.'], AGORA)?.iso, '2026-08-21T14:00:00');
check('data por extenso — "25 de agosto às 11h"',
  extrairDataHora(['Sua consulta foi marcada para 25 de agosto às 11h.'], AGORA)?.iso, '2026-08-25T11:00:00');
check('ano vira o próximo quando a data já passou',
  extrairDataHora(['Está agendado para 05/01 às 10h.'], AGORA)?.iso, '2027-01-05T10:00:00');
check('sem hora → null (não inventa horário)',
  extrairDataHora(['Está agendado para 21/08.'], AGORA), null);
check('sem data → null',
  extrairDataHora(['Seu horário ficou confirmado às 12h.'], AGORA), null);
check('unidade ausente não vira lixo',
  extrairDataHora(['Está agendado para 21/08 às 14h.'], AGORA)?.unidade, undefined);

// ── 4. Reconhecimento de slug de criação ─────────────────────

console.log('\n[4] SLUG_CRIACAO_RE');

for (const slug of ['google_calendar_criar_evento', 'realizar_agendamento', 'create_event', 'agendar_consulta']) {
  check(`reconhece ${slug}`, SLUG_CRIACAO_RE.test(slug), true);
}
for (const slug of ['google_calendar_horarios_disponiveis', 'google_calendar_listar_eventos', 'consulta_agendada', 'encerrar_conversa', 'google_calendar_cancelar_evento', 'atualizar_lead_crm']) {
  check(`ignora ${slug}`, SLUG_CRIACAO_RE.test(slug), false);
}

// ── 5. Já criou evento? ──────────────────────────────────────

console.log('\n[5] criouEventoNesteTurno');

const okTool: ToolCallLog = { tool: 'google_calendar_criar_evento', arguments: {}, result: { success: true, id: 'evt_1' } };
const erroTool: ToolCallLog = { tool: 'google_calendar_criar_evento', arguments: {}, result: { error: 'Horário fora do expediente.' } };
const crmTool: ToolCallLog = { tool: 'atualizar_lead_crm', arguments: { stage: 'won' }, result: { success: true } };

check('criou neste turno', criouEventoNesteTurno([crmTool, okTool]), true);
check('tentou e falhou não conta', criouEventoNesteTurno([erroTool]), false);
check('só CRM não conta (o caso real)', criouEventoNesteTurno([crmTool]), false);
check('resultado string JSON de sucesso',
  criouEventoNesteTurno([{ tool: 'realizar_agendamento', arguments: {}, result: '{"success":true}' }]), true);
check('resultado string JSON de erro',
  criouEventoNesteTurno([{ tool: 'realizar_agendamento', arguments: {}, result: '{"success":false,"error":"x"}' }]), false);

const log = (intent_key: string, success: boolean, response_data: unknown = {}): IntentLog =>
  ({ id: 'x', intent_key, arguments: '{}', response_data, success, created_at: '2026-08-20T12:00:00Z' });

// A checagem "esta conversa já tem compromisso" é uma query dedicada
// (`conversaTemCompromissoCriado`), não uma varredura dos últimos logs: a
// conversa da Duda em 14/08 remetia a um agendamento de 31/07, fora de qualquer
// janela de recência. O guard recebe o resultado pronto em `jaTemCompromisso`.

// ── 6. Slots para a reoferta ─────────────────────────────────

console.log('\n[6] slotsOferecidos — payload real do google-calendar-proxy');

const respostaReal = {
  settings: { min_advance_hours: 2, slot_duration_minutes: 60 },
  available_slots: [
    { day: 'quinta', date: '2026-08-20', slots: ['12:00', '13:00', '16:00'],
      slots_por_unidade: [
        { horario: '12:00', unidade: 'Ibiporã' },
        { horario: '13:00', unidade: 'Ibiporã' },
        { horario: '16:00', unidade: 'Ibiporã' },
      ] },
    { day: 'sexta', date: '2026-08-21', slots: ['12:00'],
      slots_por_unidade: [{ horario: '12:00', unidade: 'Londrina' }] },
  ],
};

check('extrai e rotula os slots',
  slotsOferecidos([log('google_calendar_horarios_disponiveis', true, respostaReal)]),
  ['quinta, 20/08 às 12:00 em Ibiporã', 'quinta, 20/08 às 13:00 em Ibiporã', 'quinta, 20/08 às 16:00 em Ibiporã', 'sexta, 21/08 às 12:00 em Londrina']);
check('agenda vazia não quebra',
  slotsOferecidos([log('google_calendar_horarios_disponiveis', true, { available_slots: [] })]), []);
check('sem consulta de horários na conversa',
  slotsOferecidos([log('atualizar_lead_crm', true)]), []);

console.log('\n[7] mensagemDeReoferta');
check('com slots, 2 mensagens', mensagemDeReoferta(['quinta, 20/08 às 13:00 em Ibiporã']).length, 2);
check('sem slots, 2 mensagens', mensagemDeReoferta([]).length, 2);
check('sem slots não inventa horário',
  /\d{1,2}:\d{2}/.test(mensagemDeReoferta([]).join(' ')), false);

// ── 8. Fluxo completo ────────────────────────────────────────

const intentsLeandro: AgentIntent[] = [
  { id: '1', slug: 'google_calendar_criar_evento', trigger_description: '' },
  { id: '2', slug: 'google_calendar_horarios_disponiveis', trigger_description: '' },
  { id: '3', slug: 'encerrar_conversa', trigger_description: '' },
];

function espiao(resposta: string) {
  const chamadas: Array<{ intent_key: string; arguments: Record<string, unknown> }> = [];
  const fn = async (args: { intent_key: string; arguments: Record<string, unknown> }) => {
    chamadas.push(args);
    return resposta;
  };
  return { chamadas, fn };
}

const CTX_BASE = {
  agent_id: '204c3466-eb2c-48d9-a7fe-856fbcba3e4d',
  conversation_id: '58c7d6fc-c3ff-42ae-bc8e-edf3dd101592',
  lead_id: '58c7d6fc-c3ff-42ae-bc8e-edf3dd101592',
  contact_phone: '554396793376',
  intents: intentsLeandro,
  agora: AGORA,
};

async function fluxo() {
  console.log('\n[8] garantirAgendamento — fluxo completo');

  // Reproduz o turno real: o Orquestrador mandou só a task de CRM.
  {
    const { chamadas, fn } = espiao('{"success":true,"id":"evt_novo"}');
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [log('google_calendar_horarios_disponiveis', true, respostaReal)], jaTemCompromisso: false,
      toolsDoTurno: [crmTool],
      mensagens: ['Rua João Antônio Cabrera Molina, 106 – Zona 4, em Ibiporã.', 'Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.'],
      executarIntent: fn,
    });
    check('caso real → repara', r.acao, 'reparado');
    check('chamou a intent certa', chamadas[0]?.intent_key, 'google_calendar_criar_evento');
    check('com a data/hora certa', chamadas[0]?.arguments,
      { action: 'create_event', startDateTime: '2026-08-20T12:00:00', location: 'Ibiporã' });
  }

  // Caminho feliz: o evento já foi criado neste turno. Nada pode acontecer.
  {
    const { chamadas, fn } = espiao('{"success":true}');
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [], jaTemCompromisso: false,
      toolsDoTurno: [okTool],
      mensagens: ['Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.'],
      executarIntent: fn,
    });
    check('evento criado no turno → não faz nada', r.acao, 'nada');
    check('não chamou intent nenhuma', chamadas.length, 0);
  }

  // Evento criado num turno anterior da mesma conversa — inclusive semanas antes.
  // (Conversa real da Duda em 14/08 remetia a um agendamento feito em 31/07.)
  {
    const { chamadas, fn } = espiao('{"success":true}');
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [],
      jaTemCompromisso: true,
      toolsDoTurno: [],
      mensagens: ['Confirmado! Te espero quinta, 20/08 às 12h.'],
      executarIntent: fn,
    });
    check('evento já existia na conversa → não duplica', r.acao, 'nada');
    check('não chamou intent nenhuma', chamadas.length, 0);
  }

  // Agenda recusou (slot ocupado / antecedência): reoferece sem envolver humano.
  {
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [log('google_calendar_horarios_disponiveis', true, respostaReal)], jaTemCompromisso: false,
      toolsDoTurno: [crmTool],
      mensagens: ['Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.'],
      executarIntent: espiao('{"error":"Agendamento requer no mínimo 2 hora(s) de antecedência."}').fn,
    });
    check('criação recusada → reoferta', r.acao, 'reoferta');
    check('reoferta traz horários reais da agenda',
      r.acao === 'reoferta' && r.mensagens.join(' ').includes('13:00'), true);
    check('reoferta não transfere para humano',
      r.acao === 'reoferta' && !/humano|atendente|equipe t[eé]cnica/i.test(r.mensagens.join(' ')), true);
  }

  // Agente sem intent de agenda: guard não é assunto dele.
  {
    const { chamadas, fn } = espiao('{"success":true}');
    const r = await garantirAgendamento({
      ...CTX_BASE,
      intents: [{ id: '1', slug: 'consultar_preco', trigger_description: '' }],
      logsDaConversa: [], jaTemCompromisso: false,
      toolsDoTurno: [],
      mensagens: ['Seu horário ficou para quinta, 20/08 às 12h.'],
      executarIntent: fn,
    });
    check('agente sem agenda → não faz nada', r.acao, 'nada');
    check('não chamou intent nenhuma', chamadas.length, 0);
  }

  // Confirmação sem data/hora: sem "quando" não há o que criar, e reescrever a
  // resposta atrapalharia turnos saudáveis (o replay mostrou 6 casos assim em
  // 30 dias, todos referindo agendamento existente). Deixa passar.
  {
    const { chamadas, fn } = espiao('{"success":true}');
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [log('google_calendar_horarios_disponiveis', true, respostaReal)],
      jaTemCompromisso: false,
      toolsDoTurno: [],
      mensagens: ['Prontinho, está tudo agendado! 😊'],
      executarIntent: fn,
    });
    check('confirmação sem data/hora → não age', r.acao, 'nada');
    check('não chamou intent nenhuma', chamadas.length, 0);
  }

  // Falha-aberto: erro dentro do guard não pode segurar a resposta.
  {
    const r = await garantirAgendamento({
      ...CTX_BASE,
      logsDaConversa: [], jaTemCompromisso: false,
      toolsDoTurno: [],
      mensagens: ['Seu horário ficou para quinta, 20/08 às 12h em Ibiporã.'],
      executarIntent: async () => { throw new Error('rede caiu'); },
    });
    check('exceção → resposta segue intacta', r.acao, 'nada');
  }

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}

void fluxo();



