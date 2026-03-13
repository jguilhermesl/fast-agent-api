import OpenAI from 'openai';
import { config } from '../config';
import { getAgentIntents, getIntentLogs, saveTokenUsage, calcCostUsd, inferModelProvider, logError } from '../services/supabase';
import {
  handleExecutarIntent,
  handleAtualizarLeadCRM,
  handleEnviarArquivo,
  handleKnowledgeBase,
} from '../tools/handlers';
import { 
  EXECUTOR_TOOLS, 
  toOpenAITools,
  createDynamicToolsFromIntents,
  combineTools
} from '../tools/definitions';
import type { ExecutorInput, ExecutorTrace, ToolCallLog } from '../types';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

const MAX_TOOL_ROUNDS = 8;

// ── Formata logs de execuções anteriores ─────────────────────

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

function buildExecutorPrompt(intentLogsText: string): string {
  return `<acoes_executadas>
${intentLogsText}
</acoes_executadas>

---

# PAPEL
Você é o Executor.
Recebe um array de tarefas do Orquestrador e as processa usando as ferramentas disponíveis.
Não conversa com o usuário. Não gera respostas ao cliente — apenas executa ações e retorna resultados estruturados.

# PROCESSAMENTO DAS TAREFAS
A tarefa chega como um array JSON. Cada item tem: tipo, objetivo, pedido_do_cliente, contexto, valor.
Processe cada item em sequência. Nunca pule um item.
Use o campo "contexto" e o histórico da conversa para montar os argumentos corretos.

# FERRAMENTAS DISPONÍVEIS
Você tem acesso a ferramentas específicas para cada ação:
- **Ações de negócio**: Use as tools específicas de cada intent (ex: agendar_consulta, consultar_preco)
- **agent_knowledge_base**: Busca informações na base de conhecimento
- **atualizar_lead_crm**: Atualiza o estágio do lead no CRM
- **enviar_arquivo**: Envia arquivo/mídia para o cliente

# MAPEAMENTO TIPO → AÇÃO

| Tipo          | Ação                                                          |
|---------------|---------------------------------------------------------------|
| CONSULTA      | agent_knowledge_base (use "objetivo" como query)             |
| AÇÃO          | Use a tool específica da ação (ex: agendar_consulta)        |
| AGENDAMENTO   | Use a tool de agendamento com data/hora do campo "valor"    |
| VENDA         | Use tool específica para consultar preços ou registrar       |
| CONVERSÃO     | Use tool de conversão + atualizar_lead_crm com "convertido" |
| ARQUIVO       | enviar_arquivo (se já tem URL)                               |
| CRM           | atualizar_lead_crm — use o campo "valor" como novo stage     |
| TRANSFERÊNCIA | não chame ferramenta — inclua REDIRECT_HUMAN no retorno      |
| CONTEXTO      | analise o contexto da conversa sem ferramenta externa        |

# REGRAS
- Nunca invente informações ou argumentos que não estejam no contexto
- Processe todos os itens do array sem pular nenhum
- Use agent_knowledge_base no máximo 2x por execução
- Se não encontrar dados, informe claramente no resultado
- Se uma ferramenta retornar erro, registre o erro e continue os demais itens
- Use os dados do "contexto" e do histórico para preencher os argumentos corretamente

# FORMATO DO RETORNO
Retorne um texto estruturado com os resultados de cada tarefa, na ordem em que foram executados.
Se houver TRANSFERÊNCIA, inclua a linha: REDIRECT_HUMAN=true`;
}

// ── Executor Agent (OpenAI tool calling loop) ─────────────────

export interface ExecutorResult {
  result: string;
  trace: ExecutorTrace;
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorResult> {
  const [intents, intentLogs] = await Promise.all([
    getAgentIntents(input.agent_id),
    getIntentLogs(input.agent_id, input.conversation_id),
  ]);

  // Cria tools dinâmicas a partir das intents do banco
  const dynamicTools = createDynamicToolsFromIntents(intents);
  console.log(dynamicTools)
  const allTools = combineTools(EXECUTOR_TOOLS, dynamicTools);
  
  // Cria um Set com os nomes das intents para lookup rápido
  const intentSlugs = new Set(intents.map(intent => intent.slug));

  const systemPrompt = buildExecutorPrompt(formatIntentLogs(intentLogs));

  const contextBlock = input.conversation_context
    ? `<historico_conversa>\n${input.conversation_context}\n</historico_conversa>\n\n`
    : '';

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `${contextBlock}<mensagem_atual_do_cliente>\n${input.client_messages}\n</mensagem_atual_do_cliente>\n\n<tarefas>\n${input.query}\n</tarefas>`,
    },
  ];

  const tools = toOpenAITools(allTools);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let usedModel = 'gpt-4.1-mini';
  let rounds = 0;
  const toolsCalledLog: ToolCallLog[] = [];

  const buildTrace = (finalResult: string): ExecutorResult => {
    const cost_usd = calcCostUsd(usedModel, totalInputTokens, totalOutputTokens);
    return {
      result: finalResult,
      trace: {
        called: true,
        rounds,
        model: usedModel,
        tokens_input: totalInputTokens,
        tokens_output: totalOutputTokens,
        cost_usd,
        tools_called: toolsCalledLog,
        query: input.query,
        result: finalResult,
      },
    };
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1;
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
        agent_id: input.agent_id,
        conversation_id: input.conversation_id,
        lead_id: input.lead_id,
        model_provider: inferModelProvider(usedModel),
        model_name: usedModel,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        estimated_cost_usd: calcCostUsd(usedModel, totalInputTokens, totalOutputTokens),
      });
      return buildTrace(msg.content ?? '(sem resposta)');
    }

    // Processa tool calls
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      let result: string;

      // Verifica se é uma tool estática
      if (toolName === 'atualizar_lead_crm') {
        result = await handleAtualizarLeadCRM(args as { stage: string }, input);
      } else if (toolName === 'enviar_arquivo') {
        result = await handleEnviarArquivo(args as { file_url: string }, input);
      } else if (toolName === 'agent_knowledge_base') {
        result = await handleKnowledgeBase(args as { query: string }, input);
      } 
      // Verifica se é uma intent dinâmica
      else if (intentSlugs.has(toolName)) {
        result = await handleExecutarIntent(
          { intent_key: toolName, arguments: args },
          input
        );
      } 
      // Tool desconhecida
      else {
        result = JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
      }

      // Registra no log
      let parsedResult: unknown = result;
      try { parsedResult = JSON.parse(result); } catch { /* mantém string */ }
      toolsCalledLog.push({ tool: toolName, arguments: args, result: parsedResult });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Chegou no limite de rounds — salva tokens e retorna o que tem
  await saveTokenUsage({
    agent_id: input.agent_id,
    conversation_id: input.conversation_id,
    lead_id: input.lead_id,
    model_provider: inferModelProvider(usedModel),
    model_name: usedModel,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    total_tokens: totalInputTokens + totalOutputTokens,
    estimated_cost_usd: calcCostUsd(usedModel, totalInputTokens, totalOutputTokens),
  });

  await logError({
    conversation_id: input.conversation_id,
    agent_id: input.agent_id,
    lead_id: input.lead_id,
    error_message: `Executor atingiu limite de ${MAX_TOOL_ROUNDS} rounds`,
    provider_failed: 'openai',
    layer: 'executor',
  });

  return buildTrace('(executor atingiu limite de execução)');
}
