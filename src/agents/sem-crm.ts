/**
 * Tira do system prompt o bloco `<crm>` que o n8n monta (estágio atual, estágios disponíveis e a
 * ordem "sempre que houver avanço, inclua uma tarefa do tipo CRM"). 04/11/2026: ninguém usa o
 * estágio que a IA gravava, e a ordem gerava rodada do orquestrador e chamada do executor só
 * para isso. Junto saem o tipo CRM do `chamar_executor` e a ferramenta `atualizar_lead_crm`
 * (tools/definitions.ts). O n8n continua mandando o bloco; quem tira é o código.
 */
const BLOCO_CRM = /\n?<crm>[\s\S]*?<\/crm>\n?/;

export function semBlocoCrm(system: string): string {
  return system.replace(BLOCO_CRM, '\n');
}
