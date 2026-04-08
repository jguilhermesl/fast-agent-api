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

function getCurrentDateBR(): string {
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildExecutorPrompt(intentLogsText: string): string {
  const currentDate = getCurrentDateBR();
  return `<data_atual>${currentDate}</data_atual>

<acoes_executadas>
${intentLogsText}
</acoes_executadas>

---

# PAPEL
Você é o Executor.
Recebe um array de tarefas do Orquestrador e as processa usando as ferramentas disponíveis.
Não conversa com o usuário. Não gera respostas ao cliente — apenas executa ações e retorna resultados estruturados.

# PROCESSAMENTO DAS TAREFAS
A tarefa chega como um array JSON. Cada item tem: tipo, objetivo, pedido_do_cliente, contexto, valor.
Processe cada item em sequência.

## Regra de ouro — validar antes de executar
Antes de chamar QUALQUER intent ou tool (exceto CRM e TRANSFERÊNCIA), verifique se TODOS os argumentos obrigatórios estão disponíveis no campo "contexto", no histórico da conversa ou no "pedido_do_cliente".
- ✅ Todos os dados presentes → execute a intent normalmente
- ❌ Algum dado obrigatório ausente ou ambíguo → NÃO execute a intent. Retorne: "intent não executada: falta [dado ausente]". O orquestrador pedirá o dado ao cliente.

**Jamais invente, assuma ou complete argumentos que não estejam explicitamente disponíveis no contexto.**

## Regra de deduplicação — não repita o que já foi feito
Antes de chamar uma intent, consulte \`<acoes_executadas>\`.
- Se a mesma intent já foi executada com sucesso com argumentos equivalentes nesta conversa → **não execute novamente**. Use o resultado anterior.
- Se foi executada mas falhou → pode tentar novamente se o contexto mudou.

# FERRAMENTAS DISPONÍVEIS
- **Intents de negócio**: tools específicas do agente (ex: agendar_consulta, consultar_preco)
- **agent_knowledge_base**: busca informações na base de conhecimento
- **atualizar_lead_crm**: atualiza o estágio do lead no CRM
- **enviar_arquivo**: envia arquivo/mídia para o cliente

# PRIORIDADE DE EXECUÇÃO

## Regra 1 — Intent específica sempre primeiro
Se existe uma tool específica para a tarefa, execute-a PRIMEIRO — mas somente após validar os dados (regra de ouro acima).
Nunca substitua uma intent específica pela agent_knowledge_base.

## Regra 2 — KB apenas quando agrega valor real
Chame agent_knowledge_base após uma intent somente se a intent retornou dados insuficientes e há informações complementares relevantes na KB (ex: condições especiais, restrições, regras de negócio adicionais).
**Não chame KB de forma especulativa** ("o cliente provavelmente vai perguntar") — isso gera tokens desnecessários.

## Regra 3 — Query da KB deve ser curta e baseada em palavras-chave
Máximo de 3 a 6 palavras. Extraia termos-chave do contexto — não use frases completas.
❌ Errado: query="Verificar política de desconto para contratar higienização e impermeabilização juntos"
✅ Certo: query="desconto pacote higienização impermeabilização"
✅ Certo: query="condição especial dois serviços"

## Regra 4 — Quando NÃO chamar a KB
- Tarefa do tipo CRM → proibido chamar KB
- Tarefa do tipo TRANSFERÊNCIA → proibido chamar KB
- A intent já retornou todas as informações necessárias
- KB já foi chamada 2 vezes nesta execução

# MAPEAMENTO TIPO → AÇÃO

| Tipo          | Ação                                                                                                      |
|---------------|-----------------------------------------------------------------------------------------------------------|
| CONSULTA      | agent_knowledge_base com query específica — KB é a fonte principal                                       |
| AÇÃO          | Valida dados → intent específica → KB complementar apenas se necessário                                  |
| AGENDAMENTO   | Valida dados → intent de agendamento → KB para restrições adicionais apenas se necessário               |
| VENDA         | Valida dados → intent de preço/venda → KB para descontos/condições apenas se necessário                 |
| CONVERSÃO     | Valida dados → intent de conversão → atualizar_lead_crm → KB apenas se necessário                      |
| ARQUIVO       | enviar_arquivo com a URL disponível                                                                       |
| CRM           | Leia SOMENTE o campo "valor" → execute SOMENTE atualizar_lead_crm. Ignore todos os outros campos. Proibido chamar qualquer outra tool, intent ou KB. |
| TRANSFERÊNCIA | Não chame ferramenta — inclua REDIRECT_HUMAN e TRANSFER_REASON no retorno                               |
| CONTEXTO      | agent_knowledge_base com query específica sobre o contexto da dúvida                                    |

# REGRAS
- **Nunca invente argumentos** — se o dado não está no contexto ou histórico, não execute a intent
- **Nunca repita intents** que já foram executadas com sucesso com os mesmos argumentos
- Use agent_knowledge_base no máximo 2x por execução
- Se uma tool retornar erro, registre de forma neutra ("informação não disponível") e continue os demais itens
- ⚠️ DATAS: Use SEMPRE o ano/mês/dia de <data_atual> como referência. "Amanhã", "semana que vem" etc. são calculados a partir de <data_atual>.

# FORMATO DO RETORNO
Retorne um texto estruturado com os resultados de cada tarefa, na ordem em que foram executados.
Se houver TRANSFERÊNCIA, inclua as duas linhas abaixo ao final do retorno:
REDIRECT_HUMAN=true
TRANSFER_REASON=<motivo objetivo em uma frase, ex: "Cliente solicitou falar com atendente humano", "Dúvida sobre contrato fora do escopo do agente", "Cliente insatisfeito com atendimento">`;
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
      model: 'gpt-5.4-mini',
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
