// ============================================================
// Tool definitions — schemas para cada provider
// ============================================================

// ── Schema neutro (usado internamente e convertido por provider) ──

export const EXECUTOR_TOOLS = [
  {
    name: 'executar_intent',
    description:
      'Executa uma intenção configurada no banco (agent_intents) para o agente atual. ' +
      'Use para ações operacionais: agendamento, consulta de dados, envio de mensagens, etc. ' +
      'Sempre informe intent_key (slug da intent) e os argumentos necessários.',
    parameters: {
      type: 'object',
      properties: {
        intent_key: {
          type: 'string',
          description: 'Slug da intent a executar (ex: "agendar_consulta", "consultar_preco")',
        },
        arguments: {
          type: 'object',
          description: 'Parâmetros necessários para a intent conforme o request_schema dela',
        },
      },
      required: ['intent_key', 'arguments'],
    },
  },
  {
    name: 'atualizar_lead_crm',
    description:
      'Atualiza o estágio do lead no CRM. Use quando o lead avança ou muda de fase no funil.',
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Novo estágio do lead no CRM (ex: "agendamento_confirmado", "proposta_enviada")',
        },
      },
      required: ['stage'],
    },
  },
  {
    name: 'enviar_arquivo',
    description:
      'Envia um arquivo/mídia para o usuário. Use quando o usuário pedir: foto, documento, ' +
      'áudio, PDF, exame, imagem. Ou quando o fluxo exigir envio de arquivo.',
    parameters: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'URL do arquivo a enviar',
        },
      },
      required: ['file_url'],
    },
  },
  {
    name: 'agent_knowledge_base',
    description:
      'Busca informações na base de conhecimento da empresa usando busca semântica. ' +
      'Use para: preços, horários, serviços, políticas, procedimentos, agendamento, ' +
      'formas de pagamento e qualquer informação específica da empresa. ' +
      'Acione no máximo 2 vezes — se não encontrar, informe que não encontrou.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Texto da busca — seja específico sobre o que precisa encontrar',
        },
      },
      required: ['query'],
    },
  },
] as const;

export const ORCHESTRATOR_TOOLS = [
  {
    name: 'chamar_executor',
    description:
      'Executa tarefas específicas: busca informações na base de conhecimento, ' +
      'executa intenções do agente (agendamento, consulta de preços, etc.), ' +
      'envia arquivos, atualiza CRM e redireciona para humano quando necessário. ' +
      'Use sempre que precisar buscar informações ou executar uma ação antes de responder ao usuário. ' +
      'IMPORTANTE: chame apenas UMA vez por turno, enviando TODAS as tarefas em um único array JSON.',
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description:
            'Array JSON com todas as tarefas a executar. Exemplo: ' +
            '[{"tipo":"CONSULTA","objetivo":"buscar preços","contexto":"cliente perguntou sobre planos"},' +
            '{"tipo":"CRM","objetivo":"atualizar lead","valor":"proposta_enviada"}]',
        },
      },
      required: ['input'],
    },
  },
] as const;

// ── Conversores por provider ──────────────────────────────────

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// OpenAI format
export function toOpenAITools(tools: readonly ToolDef[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// Anthropic format
export function toAnthropicTools(tools: readonly ToolDef[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// Gemini format
export function toGeminiTools(tools: readonly ToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}
