/**
 * Prompt do agente montado a partir do banco, para quem chama o /api/chat sem `system_prompt`
 * (demonstração pública, `demo-chat`). Mesmo texto do Prompt_Variavel do n8n (ver montar-prompt.ts).
 */
import { carregarEntrada } from './carregar-entrada';
import { montarPrompt } from './montar-prompt';

// Conversa sem linha no banco (demonstração): ids nulos fazem as leituras por conversa e por lead
// voltarem vazias, sem erro de uuid. O histórico do turno continua vindo do Redis (scoped_client_id).
const SEM_CONVERSA = '00000000-0000-0000-0000-000000000000';

export async function montarPromptDoBanco(
  agentId: string,
  contatoTelefone: string,
  deps: { carregar: typeof carregarEntrada; montar: typeof montarPrompt } = { carregar: carregarEntrada, montar: montarPrompt },
): Promise<string> {
  const entrada = await deps.carregar({
    agentId,
    conversationId: SEM_CONVERSA,
    leadId: SEM_CONVERSA,
    contatoTelefone,
    recebidoEm: new Date(),
  });
  return deps.montar(entrada);
}

