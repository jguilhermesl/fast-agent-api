import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { getHistory, appendHistory } from '../memory/redis';
import { saveTokenUsage, calcCostUsd, logError } from '../services/supabase';
import { runExecutor } from './executor';
import { ORCHESTRATOR_TOOLS, toOpenAITools, toAnthropicTools, toGeminiTools } from '../tools/definitions';
import type { ChatRequest, ChatResponse, ChatMessage } from '../types';

const openai   = new OpenAI({ apiKey: config.openaiApiKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
// const genai    = new GoogleGenerativeAI(config.googleApiKey);

const MAX_TOOL_ROUNDS = 5;
const FALLBACK_RESPONSE: ChatResponse = {
  mensagens: ['Desculpe, estou com uma instabilidade no momento. Pode tentar novamente em instantes? 🙏'],
  redirect_human: false,
};

// ── Parse do output do Orquestrador ──────────────────────────

function parseOrchestratorOutput(raw: string): ChatResponse {
  // Tenta JSON puro
  try {
    const parsed = JSON.parse(raw);
    if (parsed.mensagens) return parsed as ChatResponse;
  } catch {}

  // Tenta extrair JSON de dentro do texto
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.mensagens) return parsed as ChatResponse;
    }
  } catch {}

  // Fallback: texto bruto como array de mensagens
  const text = raw.trim();
  return {
    mensagens: text ? [text] : FALLBACK_RESPONSE.mensagens,
    redirect_human: false,
  };
}

// ── OpenAI Orchestrator ───────────────────────────────────────

async function runOpenAI(req: ChatRequest, history: ChatMessage[]): Promise<{ output: string; tokensIn: number; tokensOut: number; model: string }> {
  const tools = toOpenAITools(ORCHESTRATOR_TOOLS);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system_prompt },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: req.client_messages },
  ];

  let totalIn = 0, totalOut = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await openai.chat.completions.create({
      model: req.model_name,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.5,
    });

    const msg = response.choices[0].message;
    totalIn  += response.usage?.prompt_tokens     ?? 0;
    totalOut += response.usage?.completion_tokens ?? 0;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { output: msg.content ?? '', tokensIn: totalIn, tokensOut: totalOut, model: response.model };
    }

    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as { input: string };
      const result = await runExecutor({
        query: args.input,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  throw new Error('OpenAI orchestrator hit max rounds');
}

// ── Anthropic Orchestrator ────────────────────────────────────

async function runAnthropic(req: ChatRequest, history: ChatMessage[]): Promise<{ output: string; tokensIn: number; tokensOut: number; model: string }> {
  const tools = toAnthropicTools(ORCHESTRATOR_TOOLS);

  type AnthropicMsg = Anthropic.MessageParam;
  const messages: AnthropicMsg[] = [
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: req.client_messages },
  ];

  let totalIn = 0, totalOut = 0;
  const usedModel = req.model_name;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: usedModel,
      max_tokens: 4096,
      system: req.system_prompt,
      messages,
      tools: tools as Anthropic.Tool[],
    });

    totalIn  += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const output = textBlock?.type === 'text' ? textBlock.text : '';
      return { output, tokensIn: totalIn, tokensOut: totalOut, model: usedModel };
    }

    // Adiciona resposta do assistente com tool_use
    messages.push({ role: 'assistant', content: response.content });

    // Processa tool_use blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const args = block.input as { input: string };
      const result = await runExecutor({
        query: args.input,
        agent_id: req.agent_id,
        conversation_id: req.conversation_id,
        lead_id: req.lead_id,
        contact_phone: req.contact_phone,
        scoped_client_id: req.scoped_client_id,
        client_messages: req.client_messages,
      });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Anthropic orchestrator hit max rounds');
}

// ── Gemini Orchestrator ───────────────────────────────────────

// async function runGemini(req: ChatRequest, history: ChatMessage[]): Promise<{ output: string; tokensIn: number; tokensOut: number; model: string }> {
//   const tools = toGeminiTools(ORCHESTRATOR_TOOLS);
//   const model = genai.getGenerativeModel({
//     model: req.model_name,
//     tools: tools as Parameters<typeof genai.getGenerativeModel>[0]['tools'],
//     systemInstruction: req.system_prompt,
//   });

//   const geminiHistory = history.map((m) => ({
//     role: m.role === 'assistant' ? 'model' : 'user',
//     parts: [{ text: m.content }],
//   }));

//   const chat = model.startChat({ history: geminiHistory });

//   let totalIn = 0, totalOut = 0;
//   let currentMessage = req.client_messages;

//   for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
//     const result = await chat.sendMessage(currentMessage);
//     const response = result.response;
//     totalIn  += response.usageMetadata?.promptTokenCount     ?? 0;
//     totalOut += response.usageMetadata?.candidatesTokenCount ?? 0;

//     const part = response.candidates?.[0]?.content?.parts?.[0];
//     if (!part) break;

//     // Resposta de texto final
//     if (part.text) {
//       return { output: part.text, tokensIn: totalIn, tokensOut: totalOut, model: req.model_name };
//     }

//     // Tool call
//     if (part.functionCall) {
//       const args = part.functionCall.args as { input: string };
//       const toolResult = await runExecutor({
//         query: args.input,
//         agent_id: req.agent_id,
//         conversation_id: req.conversation_id,
//         lead_id: req.lead_id,
//         contact_phone: req.contact_phone,
//         scoped_client_id: req.scoped_client_id,
//         client_messages: req.client_messages,
//       });

//       currentMessage = JSON.stringify({
//         functionResponse: {
//           name: part.functionCall.name,
//           response: { content: toolResult },
//         },
//       });
//     }
//   }

//   throw new Error('Gemini orchestrator hit max rounds');
// }

// ── Orquestrador principal (com fallback) ─────────────────────

export async function runOrchestrator(req: ChatRequest): Promise<ChatResponse> {
  const history = await getHistory(req.scoped_client_id, 18);

  let result: { output: string; tokensIn: number; tokensOut: number; model: string } | null = null;
  let providerUsed = req.model_provider;

  // Tenta provider primário
  try {
    switch (req.model_provider) {
      case 'openai':    result = await runOpenAI(req, history);    break;
      case 'anthropic': result = await runAnthropic(req, history); break;
      // case 'gemini':    result = await runGemini(req, history);    break;
      default:          result = await runOpenAI(req, history);
    }
  } catch (primaryErr) {
    const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.error(`[Orchestrator] Provider ${req.model_provider} failed:`, errMsg);

    // Fallback → OpenAI GPT-4.1-mini
    if (req.model_provider !== 'openai') {
      try {
        console.log('[Orchestrator] Trying OpenAI fallback...');
        providerUsed = 'openai';
        result = await runOpenAI({ ...req, model_name: 'gpt-4.1-mini' }, history);
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        await logError({
          conversation_id: req.conversation_id,
          agent_id: req.agent_id,
          lead_id: req.lead_id,
          error_message: `Primary: ${errMsg} | Fallback: ${fallbackMsg}`,
          provider_failed: `${req.model_provider}+openai`,
          layer: 'orchestrator',
        });
        return FALLBACK_RESPONSE;
      }
    } else {
      await logError({
        conversation_id: req.conversation_id,
        agent_id: req.agent_id,
        lead_id: req.lead_id,
        error_message: errMsg,
        provider_failed: 'openai',
        layer: 'orchestrator',
      });
      return FALLBACK_RESPONSE;
    }
  }

  if (!result) return FALLBACK_RESPONSE;

  // Salva tokens
  await saveTokenUsage({
    conversation_id: req.conversation_id,
    agent_id: req.agent_id,
    lead_id: req.lead_id,
    tokens_input: result.tokensIn,
    tokens_output: result.tokensOut,
    cost_usd: calcCostUsd(result.model, result.tokensIn, result.tokensOut),
    model: result.model,
    layer: 'orchestrator',
  });

  // Atualiza histórico Redis
  await appendHistory(req.scoped_client_id, [
    { role: 'user',      content: req.client_messages },
    { role: 'assistant', content: result.output },
  ]);

  console.log(`[Orchestrator] provider=${providerUsed} model=${result.model} tokensIn=${result.tokensIn} tokensOut=${result.tokensOut}`);

  return parseOrchestratorOutput(result.output);
}
