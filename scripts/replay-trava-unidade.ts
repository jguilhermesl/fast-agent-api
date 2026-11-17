/**
 * Passa a trava de unidade (src/agents/trava-unidade.ts) em turnos reais já gravados, sem rede e sem LLM.
 * Mede quantas vezes ela dispararia e mostra cada caso para conferir à mão se é erro de verdade.
 *
 * Entrada: JSON de linhas { created_at, conversation_id, saida: string[], tools: [{tool,result}], ag_recentes, ult_user }
 * (interaction_logs do agente). Uso: npx tsx scripts/replay-trava-unidade.ts turnos.json config.json
 */
import fs from 'node:fs';
import { checarDataUnidade, checarServico, lerConfig, mapaDaAgenda } from '../src/agents/trava-unidade';

const linhas = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as Array<{
  created_at: string;
  conversation_id: string;
  saida: string[] | null;
  tools: Array<{ tool: string; result: unknown }> | null;
  ag_recentes: string | null;
  ult_user: string | null;
}>;
const cfg = lerConfig(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
if (!cfg) throw new Error('config inválida');

let comAgenda = 0, dataUnidade = 0, servico = 0;
for (const l of linhas) {
  const msgs = (l.saida ?? []).filter((m) => typeof m === 'string');
  if (!msgs.length) continue;
  const agenda = mapaDaAgenda((l.tools ?? []).map((t) => t.result));
  if (agenda.size) comAgenda++;
  const v = checarDataUnidade(msgs, agenda);
  const s = checarServico({
    mensagens: msgs,
    clientMessage: l.ult_user ?? '',
    falasRecentesDoAgente: l.ag_recentes ? [l.ag_recentes] : [],
    agenda,
    servicos: cfg.servicos,
    unidades: cfg.unidades,
  });
  if (v.length) {
    dataUnidade++;
    console.log(`\nDATA×UNIDADE ${l.created_at.slice(0, 16)} conv ${l.conversation_id.slice(0, 8)}: ${v.map((x) => `${x.data}@${x.unidade} (agenda ${x.unidadesDaAgenda.join('/')})`).join(', ')}`);
    console.log('   ' + msgs.join(' ⏎ ').replace(/\n/g, ' ').slice(0, 300));
  }
  if (s.length) {
    servico++;
    console.log(`\nSERVIÇO[${s.map((x) => x.tipo).join('/')}] ${l.created_at.slice(0, 16)} conv ${l.conversation_id.slice(0, 8)} | cliente: ${(l.ult_user ?? '').replace(/\n/g, ' ').slice(0, 90)}`);
    console.log('   ' + msgs.join(' ⏎ ').replace(/\n/g, ' '));
  }
}
console.log(`\nTURNOS ${linhas.length} · com agenda no turno ${comAgenda} · data×unidade ${dataUnidade} · serviço ${servico}`);
