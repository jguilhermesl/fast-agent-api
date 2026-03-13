// ============================================================
// Tool definitions — schemas para cada provider
// ============================================================

// ── Schema neutro (usado internamente e convertido por provider) ──

export const EXECUTOR_TOOLS = [
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
];

// ── Helpers para tools dinâmicas ──────────────────────────────

export interface DynamicTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function createDynamicToolsFromIntents(intents: Array<{
  slug: string;
  trigger_description: string;
  request_schema?: string | { body?: string; parameters?: unknown[] };
}>): DynamicTool[] {
  return intents.map((intent) => {
    console.log("intent ==> ", intent)
    let parameters: Record<string, unknown>;
    
    try {
      if (!intent.request_schema) {
        parameters = { type: 'object', properties: {}, required: [] };
      } else if (typeof intent.request_schema === 'string') {
        // Se for string, faz parse direto (assume que já é JSON Schema válido)
        parameters = JSON.parse(intent.request_schema);
      } else if (typeof intent.request_schema === 'object') {
        // Se for objeto, extrai o body e converte para JSON Schema
        const schema = intent.request_schema as { body?: string; parameters?: unknown[] };
        if (schema.body) {
          const bodyExample = JSON.parse(schema.body);
          // Converte o exemplo do body em JSON Schema válido
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          
          for (const [key, value] of Object.entries(bodyExample)) {
            // Infere o tipo baseado no valor de exemplo
            let type = 'string';
            if (typeof value === 'number') type = 'number';
            if (typeof value === 'boolean') type = 'boolean';
            if (Array.isArray(value)) type = 'array';
            if (value && typeof value === 'object' && !Array.isArray(value)) type = 'object';
            
            properties[key] = {
              type,
              description: `Valor para ${key}`,
            };
            required.push(key);
          }
          
          parameters = {
            type: 'object',
            properties,
            required,
          };
        } else {
          parameters = { type: 'object', properties: {}, required: [] };
        }
      } else {
        parameters = { type: 'object', properties: {}, required: [] };
      }
    } catch (err) {
      console.warn(`[Tools] Invalid request_schema for intent "${intent.slug}":`, err);
      parameters = { type: 'object', properties: {}, required: [] };
    }
    
    return {
      name: intent.slug,
      description: intent.trigger_description,
      parameters,
    };
  });
}

export function combineTools(staticTools: typeof EXECUTOR_TOOLS, dynamicTools: DynamicTool[]) {
  return [...staticTools, ...dynamicTools];
}

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
