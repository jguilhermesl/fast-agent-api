// Detecção de saudação/despedida pura.
//
// Mora em módulo próprio, e não no orchestrator, pelo mesmo motivo de
// `agendamento-guard.ts`: o orchestrator importa `config`, que exige as env vars
// do servidor. Função pura tem que ser testável sem ambiente completo.
//
// O que esta função decide: `true` desliga `tool_choice: 'required'` no round 0,
// ou seja, o Orquestrador passa a poder responder SEM chamar o Executor. O custo
// do erro é assimétrico — falso negativo é uma chamada de LLM a mais numa
// saudação; falso positivo é o agente falando de agenda e preço sem ter buscado
// nada. Por isso os padrões são ancorados no FIM (`$`), não só no início: antes,
// "Bom dia, tem consulta hoje?" (27 chars) casava o prefixo /^(bom dia)\b/ e
// desligava a busca. É o formato exato de fala de paciente de clínica.

const GREETING_PATTERNS = [
  /^(oi|olá|ola|hey|hi|hello|e aí|eai|eae|opa|oie)[\s!,.…]*$/i,
  /^(bom dia|boa tarde|boa noite|good morning|good afternoon|good evening)[\s!,.…]*$/i,
  /^(tchau|até mais|ate mais|até logo|ate logo|adeus|flw|falou|valeu|muito obrigad[oa]|obrigad[oa]|thanks|thank you)[\s!,.…😊🙏👍]*$/i,
];

// 03/11/2026: 🖐🏻 de despedida custou 2 rodadas do Sonnet + executor ("Nenhuma ação pendente").
// Confirmação curta (sozinha ou com "obrigado(a)") e emoji puro não forçam o executor; o modelo
// ainda pode chamá-lo. "sim"/"quero" ficam de fora: são aceite de oferta e pedem agendamento.
// Separado de isGreetingOrFarewell de propósito: aquela também decide o "cumprimento calado"
// (saudacao-espera.ts), que não deve mudar.
const CONFIRMACAO_PATTERNS = [
  /^(ok|okay|okey|certo|tá bom|ta bom|tá|beleza|blz|show|perfeito|combinado|entendi)([\s!,.…]+(muito )?obrigad[oa])?[\s!,.…\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]*$/iu,
  /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}️‍]+$/u,
];

/** `true` = o round 0 não precisa forçar o Executor (cumprimento, despedida, confirmação curta, emoji puro). */
export function dispensaExecutor(message: string): boolean {
  const trimmed = message.trim();
  if (isGreetingOrFarewell(trimmed)) return true;
  if (trimmed.length > 30) return false;
  return CONFIRMACAO_PATTERNS.some((p) => p.test(trimmed));
}

export function isGreetingOrFarewell(message: string): boolean {
  const trimmed = message.trim();
  // Saudação pura não passa de 30 chars. Acima disso há pergunta junto.
  if (trimmed.length > 30) return false;
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
}
