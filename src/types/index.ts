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
  client_messages: string;       // mensagem(ns) do cliente já formatada(s)
  model_provider: ModelProvider;
  model_name: string;
  system_prompt: string;         // montado pelo n8n com dados do usuário/empresa/CRM
  tenant_id?: string;
}

// Resposta que a API devolve ao n8n
export interface ChatResponse {
  mensagens: string[];
  redirect_human: boolean;
}

// Mensagem de histórico (Redis)
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── Executor ─────────────────────────────────────────────────

export interface ExecutorInput {
  query: string;                  // array JSON de tarefas do Orquestrador
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  contact_phone: string;
  scoped_client_id: string;
  client_messages: string;
}

// Intent configurada no Supabase (agent_intents)
export interface AgentIntent {
  id: string;
  slug: string;
  trigger_description: string;
  request_schema?: string;
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
  conversation_id: string;
  agent_id: string;
  lead_id: string;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  model: string;
  layer: 'orchestrator' | 'executor';
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
