import OpenAI from 'openai';
import { config } from '../config';
import { getAgentIntents, getIntentLogs, saveTokenUsage, calcCostUsd, logError } from '../services/supabase';
import {
  handleExecutarIntent,
  handleAtualizarLeadCRM,
  handleEnviarArquivo,
  handleKnowledgeBase,
} from '../tools/handlers';
import { EXECUTOR_TOOLS, toOpenAITools } from '../tools/definitions';
import type { ExecutorInput } from '../types';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

const MAX_TOOL_ROUNDS = 8;

// ── Formata intents para o prompt ────────────────────────────

function formatIntents(intents: Awaited<ReturnType<typeof getAgentIntents>>): string {
  if (!intents.length) return '(nenhuma intenção configurada para este agente)';
  return intents
    .map((it) => {
      const schema = it.request_schema ? `\n  schema: ${it.request_schema}` : '';
      return `- ${it.slug}: ${it.trigger_description}${schema}`;
    })
    .join('\n');
}

function formatIntentLogs(logs: Awaited<ReturnType<typeof getIntentLogs>>): string {
  if (!logs.length) return '(nenhuma ação executada nesta conversa ainda)';
  return logs
    .map((log) => {
      const hora = new Date(log.created_at).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const args = (() => {
        try { return JSON.stringify(JSON.parse(log.arguments ?? '{}')); }
        catch { return log.arguments ?? '{}'; }
      })();
      const status = log.success ? '✓' : '✗ falhou';
      return `[${hora}] ${log.intent_key} | args: ${args} | ${status}`;
    })
    .join('\n');
}

// ── System prompt do Executor ─────────────────────────────────

function buildExecutorPrompt(intentsText: string, intentLogsText: string): string {
  return `<intencoes_disponiveis>
${intentsText}
</intencoes_disponiveis>

<acoes_executadas>
${intentLogsText}
</acoes_executadas>

---

# PAPEL
Você é o Executor.
Recebe tarefas do Orquestrador e resolve usando as ferramentas disponíveis.
Não conversa com o usuário. Não gera respostas ao cliente — apenas executa ações e retorna resultados.

# PARSING DA TAREFA
A tarefa chega como um array JSON com múltiplos itens.
Faça o parse do array e processe cada item em sequência. Não pule nenhum item.

# MAPEAMENTO TIPO → FERRAMENTA
CONSULTA       → agent_knowledge_base
AÇÃO           → executar_intent (identifique pelo "objetivo" + "contexto")
AGENDAMENTO    → executar_intent
ARQUIVO        → enviar_arquivo ou executar_intent
CRM            → atualizar_lead_crm com o campo "valor" como stage
TRANSFERÊNCIA  → retorne "REDIRECT_HUMAN" no resultado
CONTEXTO       → analise sem ferramenta externa

# REGRAS
- nunca invente informações
- processe todos os itens do array — nunca pule um item
- use apenas o necessário para cada item
- acione agent_knowledge_base no máximo 2x por execução
- se não encontrar dados, informe claramente

# RETORNO
Retorne os resultados agrupados por tipo, na ordem em que foram executados.
Se algum item for TRANSFERÊNCIA, inclua "REDIRECT_HUMAN" no retorno.`;
}

// ── Executor Agent (OpenAI tool calling loop) ─────────────────

export async function runExecutor(input: ExecutorInput): Promise<string> {
  const [intents, intentLogs] = await Promise.all([
    getAgentIntents(input.agent_id),
    getIntentLogs(input.agent_id, input.conversation_id),
  ]);

  const systemPrompt = buildExecutorPrompt(
    formatIntents(intents),
    formatIntentLogs(intentLogs)
  );

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `<mensagem_cliente>\n${input.client_messages}\n</mensagem_cliente>\n\n<tarefa>\n${input.query}\n</tarefa>`,
    },
  ];

  const tools = toOpenAITools(EXECUTOR_TOOLS);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let usedModel = 'gpt-4.1-mini';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.3,
    });

    const msg = response.choices[0].message;
    totalInputTokens  += response.usage?.prompt_tokens     ?? 0;
    totalOutputTokens += response.usage?.completion_tokens ?? 0;
    usedModel = response.model;

    // Sem tool calls → resposta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      await saveTokenUsage({
        conversation_id: input.conversation_id,
        agent_id: input.agent_id,
        lead_id: input.lead_id,
        tokens_input: totalInputTokens,
        tokens_output: totalOutputTokens,
        cost_usd: calcCostUsd(usedModel, totalInputTokens, totalOutputTokens),
        model: usedModel,
        layer: 'executor',
      });
      return msg.content ?? '(sem resposta)';
    }

    // Processa tool calls
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      let result: string;

      switch (toolCall.function.name) {
        case 'executar_intent':
          result = await handleExecutarIntent(
            args as { intent_key: string; arguments: Record<string, unknown> },
            input
          );
          break;
        case 'atualizar_lead_crm':
          result = await handleAtualizarLeadCRM(args as { stage: string }, input);
          break;
        case 'enviar_arquivo':
          result = await handleEnviarArquivo(args as { file_url: string }, input);
          break;
        case 'agent_knowledge_base':
          result = await handleKnowledgeBase(args as { query: string }, input);
          break;
        default:
          result = JSON.stringify({ error: `Tool desconhecida: ${toolCall.function.name}` });
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Chegou no limite de rounds — salva tokens e retorna o que tem
  await saveTokenUsage({
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: input.lead_id,
    tokens_input: totalInputTokens,
    tokens_output: totalOutputTokens,
    cost_usd: calcCostUsd(usedModel, totalInputTokens, totalOutputTokens),
    model: usedModel,
    layer: 'executor',
  });

  await logError({
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: input.lead_id,
    error_message: `Executor atingiu limite de ${MAX_TOOL_ROUNDS} rounds`,
    provider_failed: 'openai',
    layer: 'executor',
  });

  return '(executor atingiu limite de execução)';
}
