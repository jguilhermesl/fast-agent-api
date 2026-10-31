/**
 * Qual modelo roda o Executor neste turno.
 *
 * Até 16/10/2026 era sempre `gpt-5.4-mini`, fixo no código. Medido na Duda nos 7
 * dias anteriores: o Executor roda em 97% dos turnos e, com o Orquestrador num
 * modelo barato, passaria a ser ~88% do custo que sobra. Trocar o modelo dele
 * precisava de deploy; agora é configuração do agente.
 *
 * Ordem de escolha:
 *   1. `executor_model` no corpo do /api/chat — só a suíte de avaliação manda,
 *      para medir um modelo sem mexer na configuração de produção;
 *   2. `agents.prompt_config.executor_model` — o que o agente usa de verdade;
 *   3. `gpt-5.4-mini` — o comportamento de sempre.
 *
 * Nome fora da lista cai no próximo da ordem em vez de chegar na OpenAI: um erro
 * de digitação no painel não pode virar "Só um momento" em toda conversa do
 * agente (foi o que derrubou o Leandro por um dia em 24/08 com o `model_name`).
 * Todos os aceitos falam o contrato de `chat.completions` com tools que o
 * Executor usa; os da família 5.6 e o gpt-6-luna recebem `reasoning_effort:
 * 'none'` em `modelo-params.ts`.
 */
import { ehModeloOpenRouter } from '../services/openrouter';

export const MODELO_EXECUTOR_PADRAO = 'gpt-5.4-mini';

export const MODELOS_EXECUTOR_ACEITOS: readonly string[] = [
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-4.1-mini',
  'gpt-5.6-luna',
  'gpt-6-luna',
  'gpt-6.1-terra',
  // Anthropic (16/10/2026): o Executor roda pelo caminho claude-* de executor.ts,
  // com cache de prompt; se falhar antes de executar ferramenta, cai no padrão.
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
];

/**
 * Aceita o nome exato ou com a data da versão (`gpt-6-luna-2026-09-22`).
 *
 * Com `aceitaOpenRouter` (o serviço tem `OPENROUTER_API_KEY`), aceita também qualquer id
 * `fornecedor/modelo` do OpenRouter (31/10/2026): o catálogo muda toda semana e uma lista
 * fixa aqui ficaria velha. Se o modelo não existir ou recusar ferramenta, o executor cai no
 * padrão antes de executar qualquer coisa (executor.ts) e o erro vai para agent_error_logs.
 */
export function modeloExecutorAceito(modelo: string, aceitaOpenRouter = false): boolean {
  if (aceitaOpenRouter && ehModeloOpenRouter(modelo)) return true;
  return MODELOS_EXECUTOR_ACEITOS.some(
    (base) => modelo === base || (modelo.startsWith(base + '-') && /^\d{4}-\d{2}-\d{2}$/.test(modelo.slice(base.length + 1)))
  );
}

export function escolherModeloExecutor(opcoes: { doCorpo?: unknown; doAgente?: unknown; aceitaOpenRouter?: boolean }): string {
  for (const candidato of [opcoes.doCorpo, opcoes.doAgente]) {
    if (typeof candidato === 'string' && modeloExecutorAceito(candidato.trim(), opcoes.aceitaOpenRouter)) return candidato.trim();
  }
  return MODELO_EXECUTOR_PADRAO;
}
