// Limpeza da mensagem do cliente antes do Orquestrador.
//
// Mora em módulo próprio, e não no orchestrator, pelo mesmo motivo de
// `saudacao.ts`: função pura tem que ser testável sem as env vars do servidor.
//
// O provedor de WhatsApp manda eventos que não são fala do cliente — mensagem
// editada, mensagem apagada — como se fossem texto: "Unsupported message type:
// edit" / "Unsupported message type: revoke". Em 30 dias (até 24/09/2026) foram
// 38 na Duda, e o agente respondia a eles ("Não consegui identificar uma
// solicitação nessa mensagem"), no meio de uma conversa que ia bem.

const EVENTO_DO_PROVEDOR = /^\s*Unsupported message type:\s*[\w-]+\s*$/i;

/** Tira as linhas que são evento do provedor. Devolve '' se não sobrar fala do cliente. */
export function limparEventosDoProvedor(texto: string): string {
  return texto
    .split('\n')
    .filter((linha) => !EVENTO_DO_PROVEDOR.test(linha))
    .join('\n')
    .trim();
}
