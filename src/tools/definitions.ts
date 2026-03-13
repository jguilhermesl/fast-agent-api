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
      'Executa todas as ações necessárias antes de responder ao cliente: ' +
      'busca na base de conhecimento, executa intenções (agendamento, consulta de preços, envio de protocolo, etc.), ' +
      'envia arquivos, atualiza CRM e redireciona para humano. ' +
      'OBRIGATÓRIO: chame esta ferramenta APENAS UMA VEZ por turno, ' +
      'com TODAS as tarefas juntas no array "tasks". Nunca chame múltiplas vezes.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Todas as tarefas a executar neste turno, em ordem de prioridade',
          items: {
            type: 'object',
            properties: {
              tipo: {
                type: 'string',
                enum: ['CONSULTA', 'AÇÃO', 'AGENDAMENTO', 'ARQUIVO', 'CRM', 'VENDA', 'CONVERSÃO', 'TRANSFERÊNCIA', 'CONTEXTO'],
                description:
                  'CONSULTA=buscar informação na base de conhecimento; ' +
                  'AÇÃO=executar uma intenção configurada; ' +
                  'AGENDAMENTO=agendar serviço/consulta; ' +
                  'ARQUIVO=enviar arquivo/mídia ao cliente; ' +
                  'CRM=atualizar estágio do lead (use "valor" com o novo stage); ' +
                  'VENDA=consultar preços ou finalizar proposta; ' +
                  'CONVERSÃO=registrar fechamento/conversão; ' +
                  'TRANSFERÊNCIA=encaminhar para atendimento humano; ' +
                  'CONTEXTO=analisar contexto sem ação externa',
              },
              objetivo: {
                type: 'string',
                description: 'O que precisa ser resolvido nesta tarefa',
              },
              pedido_do_cliente: {
                type: 'string',
                description: 'Resumo do que o cliente pediu ou informou',
              },
              contexto: {
                type: 'string',
                description: 'Informações da conversa relevantes para esta tarefa',
              },
              valor: {
                type: 'string',
                description: 'Usado em CRM (novo estágio do funil), AGENDAMENTO (data/hora) e CONVERSÃO',
              },
            },
            required: ['tipo', 'objetivo'],
          },
        },
      },
      required: ['tasks'],
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
