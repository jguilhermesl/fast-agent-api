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
      'Busca informações COMPLEMENTARES na base de conhecimento. ' +
      'Use SOMENTE para contexto adicional que não é coberto por uma intent específica: ' +
      'descontos, promoções, condições especiais, regras de negócio, observações sobre serviços, ' +
      'perguntas frequentes ou informações que enriquecem a resposta além do que a intent retornou. ' +
      'NUNCA use no lugar de uma intent específica disponível (ex: se existe consultar_preco, use ela). ' +
      'A query deve ser específica e contextual, nunca genérica. ' +
      'Acione no máximo 2 vezes por execução.',
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
  request_schema?: string | { body?: string; parameters?: Array<{
    name: string;
    type: string;
    required?: boolean;
    description?: string;
  }> };
}>): DynamicTool[] {
  return intents.map((intent) => {
    console.log(intent.trigger_description)
    let parameters: Record<string, unknown>;
    
    try {
      if (!intent.request_schema) {
        // Schema vazio
        parameters = { type: 'object', properties: {}, required: [] };
      } else if (typeof intent.request_schema === 'string') {
        // Formato 1: String (JSON Schema direto)
        parameters = JSON.parse(intent.request_schema);
      } else if (typeof intent.request_schema === 'object') {
        const schema = intent.request_schema as { 
          body?: string; 
          parameters?: Array<{
            name: string;
            type: string;
            required?: boolean;
            description?: string;
          }> 
        };
        
        // Formato 2: Objeto com array de parameters
        if (schema.parameters && Array.isArray(schema.parameters) && schema.parameters.length > 0) {
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          
          for (const param of schema.parameters) {
            properties[param.name] = {
              type: param.type,
              description: param.description || `Parâmetro ${param.name}`,
            };
            
            if (param.required) {
              required.push(param.name);
            }
          }
          
          parameters = {
            type: 'object',
            properties,
            required,
          };
        }
        // Formato 3: Objeto com body (exemplo de valores)
        else if (schema.body) {
          const bodyExample = JSON.parse(schema.body);
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          
          for (const [key, value] of Object.entries(bodyExample)) {
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
      'OBRIGATÓRIO: mande TODAS as tarefas do turno juntas no array "tasks", numa chamada só; ' +
      'nunca divida as tarefas em várias chamadas. ' +
      // 30/09/2026: "Nunca chame múltiplas vezes" brigava com a persona ("refaça a
      // busca com o termo certo"). A segunda chamada fica restrita à busca refeita;
      // o teto de rodadas do código (MAX_TOOL_ROUNDS) continua valendo.
      'Única exceção: se o retorno trouxer BUSCA_VAZIA ou um item diferente do que o cliente pediu, ' +
      'você pode chamar mais UMA vez neste turno, só com a busca refeita com outro termo. ' +
      'Nunca repita a mesma busca com o mesmo termo e nunca chame uma terceira vez.',
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
                  'AGENDAMENTO=agendar serviço/consulta (data e horário vão em "contexto", o preço vai em "valor"); ' +
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
              // 30/09/2026: dizia "AGENDAMENTO (data/hora)". Quem consome o `valor` do
              // `realizar_agendamento` (n8n "Realizar agendamento", Duda e Carol) é o
              // `conversion_value` numérico da conversão `sale`; o parser de lá descarta
              // data ("barra 13/08/2026 13:30 de virar 130820261330"). 27 de 142
              // agendamentos da Duda em 14 dias saíram com data no `valor` (estudo 09 §3).
              valor: {
                type: 'string',
                description:
                  'CRM: o slug do novo estágio do funil. ' +
                  'AGENDAMENTO, VENDA e CONVERSÃO: o preço em reais do item (ex.: "R$ 170,00"), ' +
                  'que vai para o campo "valor" da intenção. Nunca ponha data ou horário aqui: ' +
                  'data e horário vão em "contexto".',
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
