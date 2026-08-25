// ============================================================
// Replay do guard contra 30 dias de tráfego real
// ============================================================
//
//   npx tsx scripts/replay-guard.ts <arquivo.ndjson> [--todos]
//
// Prova de não-regressão. As mensagens são reagrupadas em turnos (mesma conversa,
// janela de 15 s) porque é assim que o guard vê: um array `mensagens`, não uma
// linha isolada. Para cada turno mede o que o guard faria e, quando ele agiria,
// mostra a linha para conferência à mão.
//
// `tem_evento` vem do banco: houve criação de evento bem-sucedida nessa conversa
// perto desse instante. Turno com evento é caminho feliz — o guard tem de ficar
// quieto. Turno sem evento e com confirmação é o bug que estamos caçando.

import fs from 'node:fs';
import { afirmaAgendamento, extrairDataHora } from '../src/agents/agendamento-guard';

interface Linha {
  id: string;
  created_at: string;
  conversation_id: string;
  agente: string;
  contact_name: string | null;
  content: string;
  tem_evento: boolean;
}

interface Turno {
  agente: string;
  conversation_id: string;
  created_at: string;
  mensagens: string[];
  tem_evento: boolean;
}

const arquivo = process.argv[2];
const mostrarTodos = process.argv.includes('--todos');
if (!arquivo) {
  console.error('uso: npx tsx scripts/replay-guard.ts <arquivo.ndjson> [--todos]');
  process.exit(1);
}

const linhas: Linha[] = fs.readFileSync(arquivo, 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Linha);

// ── Reagrupa em turnos ───────────────────────────────────────

const JANELA_MS = 15_000;
const turnos: Turno[] = [];
const ultimoPorConversa = new Map<string, Turno>();

for (const l of linhas) {
  const anterior = ultimoPorConversa.get(l.conversation_id);
  const dt = anterior ? new Date(l.created_at).getTime() - new Date(anterior.created_at).getTime() : Infinity;
  if (anterior && dt <= JANELA_MS) {
    anterior.mensagens.push(l.content);
    anterior.tem_evento = anterior.tem_evento || l.tem_evento;
    anterior.created_at = l.created_at;
    continue;
  }
  const t: Turno = {
    agente: l.agente,
    conversation_id: l.conversation_id,
    created_at: l.created_at,
    mensagens: [l.content],
    tem_evento: l.tem_evento,
  };
  turnos.push(t);
  ultimoPorConversa.set(l.conversation_id, t);
}

// ── Simula o guard ───────────────────────────────────────────

type Acao = 'nada' | 'nada_ja_criado' | 'nada_sem_data' | 'criaria';
const resultado: Array<{ turno: Turno; acao: Acao; iso?: string }> = [];

for (const t of turnos) {
  if (!afirmaAgendamento(t.mensagens)) {
    resultado.push({ turno: t, acao: 'nada' });
    continue;
  }
  if (t.tem_evento) {
    resultado.push({ turno: t, acao: 'nada_ja_criado' });
    continue;
  }
  const quando = extrairDataHora(t.mensagens, new Date(t.created_at));
  resultado.push(quando
    ? { turno: t, acao: 'criaria', iso: quando.iso }
    : { turno: t, acao: 'nada_sem_data' });
}

const conta = (a: Acao) => resultado.filter((r) => r.acao === a).length;

console.log(`Mensagens:  ${linhas.length}`);
console.log(`Turnos:     ${turnos.length}\n`);
console.log(`Guard fica quieto (sem confirmação):        ${conta('nada')}`);
console.log(`Guard fica quieto (evento já existe):       ${conta('nada_ja_criado')}`);
console.log(`Guard fica quieto (confirmação sem data):   ${conta('nada_sem_data')}`);
console.log(`Guard AGIRIA (criaria o evento faltante):   ${conta('criaria')}`);

const agiria = resultado.filter((r) => r.acao === 'criaria');
console.log(`\nTaxa de intervenção: ${((agiria.length / turnos.length) * 100).toFixed(3)}% dos turnos\n`);

console.log('Turnos em que o guard agiria — cada um tem de ser um agendamento fantasma real:');
for (const r of agiria) {
  const texto = r.turno.mensagens.join(' ⏎ ').replace(/\s+/g, ' ').slice(0, 130);
  console.log(`  ${r.turno.created_at.slice(0, 16)}  ${r.turno.agente.padEnd(9)} ${r.iso}  ${texto}`);
}

if (mostrarTodos) {
  console.log('\nConfirmações sem data/hora (guard passa direto, listadas para auditoria):');
  for (const r of resultado.filter((x) => x.acao === 'nada_sem_data')) {
    console.log(`  ${r.turno.created_at.slice(0, 16)}  ${r.turno.agente.padEnd(9)} ${r.turno.mensagens.join(' ⏎ ').replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}
