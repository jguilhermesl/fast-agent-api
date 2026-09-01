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

export function isGreetingOrFarewell(message: string): boolean {
  const trimmed = message.trim();
  // Saudação pura não passa de 30 chars. Acima disso há pergunta junto.
  if (trimmed.length > 30) return false;
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
}
