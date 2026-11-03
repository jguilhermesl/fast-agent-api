/**
 * Tira a ferramenta de busca na base de conhecimento do executor quando o agente pede
 * (`prompt_config.kb.busca === false`, lido em `getKbOpcoes`). Para agente com toda a base
 * no prompt: o executor não vê o prompt e buscava assim mesmo, com embedding e uma rodada a
 * mais, para voltar vazio (Duda, 03/11/2026: 60% das buscas vazias). Sem a chave, nada muda.
 */
export function semBuscaNaBase<T extends { name: string }>(ferramentas: T[], semBusca: boolean): T[] {
  return semBusca ? ferramentas.filter((f) => f.name !== 'agent_knowledge_base') : ferramentas;
}
