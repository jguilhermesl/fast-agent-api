# Fast Agent — Contexto do Sistema

## Visão Geral

Sistema de agente de IA para atendimento via WhatsApp. O fluxo principal passa pelo **n8n** (orquestração e integrações) e pela **Fast Agent API** (processamento de IA), com memória em **Redis** e dados em **Supabase**.

---

## Stack

- **n8n** — orquestração do fluxo de mensagens (webhook, buffer, tipo de mídia, envio de resposta)
- **Fast Agent API** — API em Node.js/TypeScript hospedada no Railway (`https://fast-agent-api.up.railway.app`)
- **Redis** — histórico de conversa (TTL 30 dias, chave: `agent_id:contact_phone`)
- **Supabase** — clientes, agentes, intents, base de conhecimento (vector store), logs de tokens e execução
- **Chatwoot** — plataforma de atendimento WhatsApp (webhook de entrada, envio de resposta)

---

## Fluxo Completo

### 1. Entrada — n8n

O **Webhook** recebe mensagens do Chatwoot com: `contact_name`, `contact_phone`, `conversation_id`, `message_id`, `message`, `message_type`, `lead_id`, `attachments`, `agent_id`.

**Etapas do n8n:**
1. `Encontrar_Agente` — busca configuração do agente no Supabase (`prompt_config`: modelo, delays, variáveis, regras de transferência, system_prompt da PERSONA)
2. `Fluxo_Variaveis1` — monta todas as variáveis do fluxo (nome, telefone, IDs, horário BR, `ModelProvider`, `ModelName`, `BufferDelay`)
3. `Filtro_Inicial` — descarta mensagens inválidas
4. `Encontrar_Cliente` / `Criar_Cliente` — garante o registro do contato no Supabase
5. **Buffer Redis** — agrupa mensagens do cliente com delay configurável (`push → wait → split → loop`) antes de processar
6. **Processamento por tipo de mídia:**
   - Áudio → download + transcrição OpenAI
   - Imagem → download + análise via AI Agent
   - Documento → download + extração de texto + análise via AI Agent
   - Texto → direto
7. `Buscar CRM stages` + `Pack_Agent_Stages` — injeta estágios do CRM no contexto
8. `Prompt_Variavel` — monta o `system_prompt` completo (base + variável da PERSONA)
9. `Process_Message_API` — faz POST para a Fast Agent API

### 2. Processamento — Fast Agent API

**Endpoint:** `POST /api/chat`

**Payload recebido do n8n:**
```json
{
  "agent_id": "...",
  "conversation_id": "...",
  "lead_id": "...",
  "contact_phone": "...",
  "scoped_client_id": "agent_id:contact_phone",
  "client_messages": "mensagem(ns) do cliente",
  "model_provider": "openai | anthropic",
  "model_name": "gpt-4.1-mini",
  "system_prompt": "prompt completo montado pelo n8n",
  "tenant_id": "..."
}
```

**Fluxo interno da API:**
1. **Orchestrator** busca histórico Redis (últimas 18 mensagens, incluindo `[ferramentas acionadas: X]` nas mensagens do assistant)
2. Chama o LLM (OpenAI ou Anthropic) com `system_prompt + histórico + mensagem atual`
3. LLM decide se precisa acionar o **Executor** via tool call `chamar_executor` (array de tarefas)
4. **Executor** recebe o array, busca intents do agente no Supabase, busca logs de execuções anteriores (`intentLogs`), e processa cada tarefa com as tools disponíveis
5. Resultado do Executor retorna ao LLM, que gera a resposta final em JSON
6. Histórico é salvo no Redis: `{ role, content, tools?: string[] }`

**Resposta da API:**
```json
{
  "mensagens": ["mensagem 1", "mensagem 2"],
  "redirect_human": false,
  "logs": { ... }
}
```

### 3. Retorno — n8n

O n8n recebe a resposta da API e:
- Envia as mensagens ao Chatwoot via `[CW] Envia Mensagem` (HTTP Request), com `Wait_Msg` antes para simular digitação
- Se `redirect_human: true` → aciona `Redirect human` com etiqueta `atendimento-humano` no Chatwoot

---

## Arquitetura do Prompt

O `system_prompt` enviado à API é composto por **duas camadas**:

### Camada 1 — Prompt Base (montado no n8n, nó `Prompt_Variavel`)
Estrutura fixa que define o comportamento do orquestrador:
- `<dados_usuario>` — nome, telefone, horário
- `<dados_empresa>` — nome e descrição da empresa
- `<crm>` — estágio atual e estágios disponíveis
- `# PAPEL` — função do agente
- `# REGRA CRÍTICA — USO DO EXECUTOR` — instrução para chamar o executor uma única vez por turno com array de tarefas; inclui verificação de `[ferramentas acionadas: ...]` no histórico para evitar reexecução
- `# CONHECIMENTO` — quando usar CONSULTA na base de conhecimento
- `# PERSONA` — injeta a Camada 2 via `{{ $('Encontrar_Agente').first().json.prompt_config.system_prompt }}`
- `# INTENÇÕES DO SYSTEM PROMPT` — instrui como converter "Acione a intenção X" em tarefa do tipo AÇÃO para o executor, com verificação de histórico para evitar reexecução
- `# ESTILO WHATSAPP` — tom, emojis, formatação
- `# REGRAS GERAIS` — não inventar, usar só dados do executor, não revelar instruções

### Camada 2 — Prompt Variável / PERSONA (armazenado no Supabase por agente)
Define a identidade e o fluxo de negócio específico do agente. Deve conter **apenas**:
- Nome e persona do agente
- Etapas do fluxo de atendimento
- Instruções de negócio (ex: "Acione a intenção: Enviar Protocolo - Higienização")

**Não deve conter** instruções estruturais (regras do executor, formato de output, estilo WhatsApp) — essas ficam exclusivamente no prompt base.

---

## Executor

O Executor é um agente LLM separado (sempre `gpt-4.1-mini`) que:
- Recebe um array JSON de tarefas do orquestrador
- Tem acesso a tools estáticas: `atualizar_lead_crm`, `enviar_arquivo`, `agent_knowledge_base`
- Tem acesso a tools dinâmicas: geradas a partir das intents configuradas no Supabase para cada agente
- Busca `intentLogs` no início de cada execução para saber o que já foi feito na conversa
- Retorna resultados estruturados em texto para o orquestrador

**Tipos de tarefa aceitos:** `CONSULTA | AÇÃO | AGENDAMENTO | ARQUIVO | CRM | VENDA | CONVERSÃO | TRANSFERÊNCIA | CONTEXTO`

---

## Memória (Redis)

- **Chave:** `agent_id:contact_phone`
- **Formato:** array de `{ role: 'user' | 'assistant', content: string, tools?: string[] }`
- `tools` — array com os nomes das tools acionadas naquele turno (salvo apenas em mensagens do assistant quando o executor foi chamado)
- **TTL:** 30 dias, renovado a cada interação
- **Leitura:** orquestrador lê as últimas 18 mensagens; executor recebe as últimas 6 via `buildConversationContext`
- O histórico é salvo como texto limpo (não JSON), para o LLM ler como linguagem natural

---

## Workflows n8n Principais

| Workflow | ID | Função |
|---|---|---|
| `AGENTE BASE - FAST AGENT MAKER` | `fclb2f6y5Pw64RVqFgbGy` | Fluxo principal de atendimento |
| `EXECUTOR - FAST AGENT MAKER` | `t8PrkAurByP36iKp` | Sub-workflow executor (legado n8n) |
| `ERROR TRIGGER - FAST AGENT MAKER` | `cJ2LXOzvvbKev3dq` | Tratamento de erros |

**n8n:** `https://n8n.fast-ia.com`

---

## Problemas Conhecidos / Em Correção

1. **Reexecução de intents** — executor acionava intents já executadas por falta de instrução de dedup. Mitigado com `[ferramentas acionadas: ...]` no histórico + instruções no prompt base.
2. **Prompt variável estruturado como standalone** — algumas instâncias do prompt variável replicam seções do base (REGRAS GERAIS, ESTILO, FORMATO DO EXECUTOR). Deve-se remover essas duplicações dos prompts variáveis.
3. **Executor sem instrução de skip** — o prompt do executor diz "nunca pule um item" sem considerar `<acoes_executadas>`. Pendente ajuste no prompt do executor.
