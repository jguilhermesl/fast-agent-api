// Teste de fumaça do caminho OpenRouter (31/10/2026). Uma chamada com ferramenta por modelo,
// com os MESMOS parâmetros que o orquestrador manda (services/openrouter.ts + modelo-params.ts).
// Custa centavos: rode só com aval.  npx tsx scripts/smoke-openrouter.ts [modelo ...]
// Chave: OPENROUTER_API_KEY do ambiente ou de ~/.claude/.env.local.
import fs from 'node:fs';
import os from 'node:os';
import type OpenAI from 'openai';
import { criarClienteOpenRouter, extrasOpenRouter, custoDoOpenRouter, mensagensParaOpenRouter } from '../src/services/openrouter';
import { amostragemDoModelo } from '../src/agents/modelo-params';

function chave(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const linha = fs.readFileSync(`${os.homedir()}/.claude/.env.local`, 'utf8').split(/\r?\n/).find((l) => l.startsWith('OPENROUTER_API_KEY='));
  return (linha ?? '').slice('OPENROUTER_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
}

const MODELOS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'openai/gpt-6.1-terra', 'deepseek/deepseek-v4.1-flash'];

const tools: OpenAI.Chat.ChatCompletionTool[] = [{
  type: 'function',
  function: {
    name: 'buscar_preco',
    description: 'Busca o preço de um exame da clínica.',
    parameters: { type: 'object', properties: { exame: { type: 'string' } }, required: ['exame'] },
  },
}];

const talvez = criarClienteOpenRouter(chave(), 60_000);
if (!talvez) throw new Error('sem OPENROUTER_API_KEY');
const cliente: OpenAI = talvez;

async function main(): Promise<void> {
let total = 0;
for (const modelo of MODELOS) {
  const mensagens: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Você atende uma clínica pelo WhatsApp. Para preço, use a ferramenta.' },
    { role: 'user', content: 'Quanto custa o ultrassom de tireoide?' },
  ];
  const t0 = Date.now();
  try {
    const r = await cliente.chat.completions.create({
      model: modelo,
      messages: mensagensParaOpenRouter(modelo, mensagens),
      tools,
      tool_choice: 'required',
      max_tokens: 300,
      ...amostragemDoModelo(modelo, 0.2),
      ...extrasOpenRouter('smoke-teste'),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
    const tc = r.choices[0].message.tool_calls?.[0];
    const custo = custoDoOpenRouter(r.usage) ?? 0;
    total += custo;
    const prov = (r as unknown as { provider?: string }).provider ?? '?';
    console.log(`OK   ${modelo.padEnd(32)} ${String(Date.now() - t0).padStart(5)} ms  fornecedor=${prov}  tool=${tc?.function.name ?? 'nenhuma'} args=${tc?.function.arguments ?? '-'}  custo=US$ ${custo.toFixed(6)}`);
  } catch (e) {
    console.log(`FALHA ${modelo.padEnd(31)} ${String(Date.now() - t0).padStart(5)} ms  ${e instanceof Error ? e.message.slice(0, 220) : String(e)}`);
  }
}
console.log(`total US$ ${total.toFixed(6)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
