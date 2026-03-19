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
Processe cada item em sequência. Nunca pule um item.
Use o campo "contexto" e o histórico da conversa para montar os argumentos corretos.

# FERRAMENTAS DISPONÍVEIS
Você tem acesso a ferramentas específicas para cada ação:
- **Ações de negócio**: Use as tools específicas de cada intent (ex: agendar_consulta, consultar_preco)
- **agent_knowledge_base**: Busca informações na base de conhecimento
- **atualizar_lead_crm**: Atualiza o estágio do lead no CRM
- **enviar_arquivo**: Envia arquivo/mídia para o cliente

# PRIORIDADE DE EXECUÇÃO

## Regra 1 — Intent específica sempre primeiro
Se existe uma tool específica para a tarefa (ex: consultar_preco, agendar_consulta), execute-a PRIMEIRO.
Nunca substitua uma intent específica pela agent_knowledge_base. A KB é complemento, nunca substituto.

## Regra 2 — KB como complemento contextual
Após executar a intent (ou quando não há intent específica), chame agent_knowledge_base com uma query focada no que pode existir de COMPLEMENTAR ao resultado da intent.
Exemplos do que buscar na KB após a intent:
- Condições especiais, descontos ou promoções vigentes
- Regras de negócio adicionais relevantes ao caso
- Informações que o cliente provavelmente vai perguntar em seguida
- Alertas ou observações importantes sobre o produto/serviço

## Regra 3 — Query da KB deve ser curta, direta e baseada em palavras-chave
Nunca use frases longas ou o "objetivo" completo como query. O embedding performa melhor com termos curtos e específicos (3 a 6 palavras no máximo).
Extraia as palavras-chave do que o cliente perguntou e do contexto — não elabore frases completas.
❌ Errado: query="Verificar política de desconto/pacote para contratar higienização + impermeabilização (mesmo sendo em dias diferentes) e condições de pagamento"
❌ Errado: query="consultar preço higienização colchão solteiro casal"
✅ Certo: query="desconto pacote higienização impermeabilização"
✅ Certo: query="condição especial dois serviços"
✅ Certo: query="desconto colchão higienização"

## Regra 4 — Quando NÃO chamar a KB
Não chame agent_knowledge_base quando:
- A tarefa for CRM — use APENAS o campo "valor" para identificar o novo stage. Ignore "objetivo" e "contexto" pois podem conter instruções de outros passos que não pertencem a esta tarefa. Execute SOMENTE atualizar_lead_crm e encerre imediatamente.
- A tarefa for TRANSFERÊNCIA
- A intent já retornou informação completa e não há contexto adicional relevante
- Já chamou KB 2 vezes nesta execução

# MAPEAMENTO TIPO → AÇÃO

| Tipo          | Ação                                                                                          |
|---------------|-----------------------------------------------------------------------------------------------|
| CONSULTA      | agent_knowledge_base com query específica — sem intent, KB é a fonte principal               |
| AÇÃO          | 1º tool específica da intent → 2º KB para complemento contextual (se relevante)             |
| AGENDAMENTO   | 1º tool de agendamento → 2º KB para regras/restrições adicionais (se relevante)             |
| VENDA         | 1º tool de preço/venda → 2º KB para descontos/condições especiais (se relevante)            |
| CONVERSÃO     | 1º tool de conversão → atualizar_lead_crm → KB para contexto pós-conversão (se relevante)  |
| ARQUIVO       | enviar_arquivo com a URL disponível                                                           |
| CRM           | Leia SOMENTE o campo "valor" e execute SOMENTE atualizar_lead_crm. Ignore completamente os campos "objetivo", "contexto" e "pedido_do_cliente" — eles podem conter instruções de outros passos do fluxo que NÃO são sua responsabilidade nesta tarefa. Proibido chamar qualquer outra tool, intent ou KB. |
| TRANSFERÊNCIA | não chame ferramenta — inclua REDIRECT_HUMAN no retorno                                      |
| CONTEXTO      | agent_knowledge_base com query específica sobre o contexto da dúvida                        |

# REGRAS
- Nunca invente informações ou argumentos que não estejam no contexto
- Processe todos os itens do array sem pular nenhum
- Use agent_knowledge_base no máximo 2x por execução
- Se não encontrar dados ou uma tool retornar erro, registre de forma neutra no resultado (ex: "informação não disponível") — sem expor mensagens técnicas de erro ao orquestrador
- Se uma ferramenta retornar erro, continue processando os demais itens do array
- Use os dados do "contexto" e do histórico para preencher os argumentos corretamente
- ⚠️ DATAS: Use SEMPRE o ano/mês/dia de <data_atual> como referência. Nunca assuma datas com base em treinamento. Se o cliente disser "amanhã", "semana que vem" etc., calcule a partir de <data_atual>.

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
