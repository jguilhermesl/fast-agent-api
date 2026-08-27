// ============================================================
// Types — Fast Agent API
// ============================================================

export type ModelProvider = 'openai' | 'anthropic' | 'gemini';

// Payload que chega do n8n via POST /api/chat
export interface ChatRequest {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  contact_phone: string;
  scoped_client_id: string;
  client_messages: string;            // mensagem(ns) do cliente já formatada(s)
  client_message_type?: 'text' | 'image_analysis' | 'audio_transcription'; // tipo da mensagem
  model_provider: ModelProvider;
  model_name: string;
  system_prompt: string;              // montado pelo n8n com dados do usuário/empresa/CRM
  tenant_id?: string;
}

// ── Execution Logs ────────────────────────────────────────────

export interface ToolCallLog {
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface ExecutorTrace {
  called: boolean;
  rounds: number;
  model: string;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  tools_called: ToolCallLog[];
  query?: string;
  result?: string;
}

export interface ExecutionLogs {
  history: ChatMessage[];
  orchestrator: {
    provider: string;
    model: string;
    rounds: number;
    tokens_input: number;
    tokens_output: number;
    cost_usd: number;
  };
  executor: ExecutorTrace;
  communication?: Array<{
    query: string;
    result: string;
  }>;
}

// Resposta que a API devolve ao n8n
export interface ChatResponse {
  mensagens: string[];
  redirect_human: boolean;
  transfer_reason?: string;   // motivo da transferência (presente quando redirect_human=true)
  logs: ExecutionLogs;
}

// Mensagem de histórico (Redis)
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[]; // nomes das tools acionadas neste turno (apenas em mensagens do assistant)
}

// ── Executor ─────────────────────────────────────────────────

export interface ExecutorInput {
  query: string;                    // array JSON de tarefas do Orquestrador
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  contact_phone: string;
  scoped_client_id: string;
  client_messages: string;
  conversation_context?: string;    // últimas mensagens do histórico (para dar contexto ao Executor)
}

// Intent configurada no Supabase (agent_intents)
export interface AgentIntent {
  id: string;
  slug: string;
  trigger_description: string;
  request_schema?: string | { 
    body?: string; 
    parameters?: Array<{
      name: string;
      type: string;
      required?: boolean;
      description?: string;
    }>;
  };
}

// Log de execução de intent (intent_execution_logs)
export interface IntentLog {
  id: string;
  intent_key: string;
  arguments: string;
  response_data: unknown;
  success: boolean;
  created_at: string;
}

// ── Token Tracking ────────────────────────────────────────────

export interface TokenUsage {
  tokens_input: number;
  tokens_output: number;
  model: string;
}

export interface TokenLogEntry {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  model_provider: string;
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  /**
   * Parte do input servida pelo cache de prefixo do provedor (custa ~10%).
   *
   * A coluna `cached_input_tokens` existe em `llm_usage_logs` desde sempre e estava
   * zerada em 100% das linhas — não porque o cache estivesse desligado, mas porque
   * ninguém lia `usage.prompt_tokens_details.cached_tokens` da resposta. Sem este
   * campo não há como saber se o cache pega, e o custo exibido é um teto, não a fatura.
   */
  cached_input_tokens?: number;
}

// ── Tool calling (genérico) ───────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
}
