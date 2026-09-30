// ── Sufixo de formato de saída do Orquestrador ────────────────
//
// Vai colado no fim do system_prompt (depois de tudo que o n8n montou) e garante o
// contrato JSON `{mensagens, redirect_human, transfer_reason}`.
//
// Até 30/09/2026 a linha de `mensagens` dizia sempre "Quebre em múltiplas mensagens
// curtas quando fizer sentido para WhatsApp". Isso brigava com o tamanho que o
// painel define (`prompt_config.response_style`): no estilo `conciso` o n8n manda
// "no máximo 2 frases curtas" e a persona da Duda manda valor e agenda numa
// mensagem só, mas o sufixo, que é o último texto que o modelo lê, mandava
// dividir. Resultado medido: 55% dos turnos da Duda saíam com 2+ mensagens
// (898/1.639, 24–30/09; estudo 09 §3 linha 3).
//
// Agora o sufixo obedece ao `response_style`:
//   - `conciso`: uma mensagem curta, e só divide quando houver necessidade real.
//   - qualquer outro valor (`equilibrado`, `detalhado`, ausente, desconhecido): o
//     texto de antes, byte a byte. Esses agentes não têm suíte; mudar o que eles
//     recebem sem medir não entra aqui.
//
// Função pura: sem env, sem rede. O `response_style` é lido do banco em
// `services/supabase.ts` (`getEstiloResposta`), porque o n8n não manda o campo no
// corpo do /api/chat.

const CABECALHO = `

---

# FORMATO DE RESPOSTA — OBRIGATÓRIO
Responda SOMENTE com JSON válido no formato abaixo. Nenhum texto fora do JSON.

\`\`\`json
{
  "mensagens": ["mensagem 1", "mensagem 2"],
  "redirect_human": false,
  "transfer_reason": null
}
\`\`\`

`;

const MENSAGENS_PADRAO =
  '- **mensagens**: array de strings. Quebre em múltiplas mensagens curtas quando fizer sentido para WhatsApp. Nunca retorne um array vazio.';

const MENSAGENS_CONCISO =
  '- **mensagens**: array de strings. Este agente está no estilo de resposta **conciso**: prefira UMA mensagem curta. ' +
  'Só divida em mais de uma quando houver necessidade real (por exemplo, o bloco de valor e agenda e, separada, a pergunta que conduz o próximo passo). ' +
  'Nunca uma mensagem por frase ou por detalhe. Nunca retorne um array vazio.';

const RODAPE = `
- **redirect_human**: \`true\` apenas se precisar transferir para humano, caso contrário \`false\`.
- **transfer_reason**: quando \`redirect_human\` for \`true\`, preencha com o motivo da transferência em uma frase curta (ex: "Cliente solicitou atendimento humano", "Dúvida sobre contrato fora do escopo"). Quando \`false\`, use \`null\`.
- **Proibido**: nunca termine mensagens com frases genéricas de encerramento como "Se precisar de mais alguma coisa, é só avisar!", "Fico à disposição!", "Qualquer dúvida estou aqui!" ou similares. Encerre de forma natural e direta, sem filler.`;

/** Normaliza o `prompt_config.response_style` como o n8n faz (`|| 'equilibrado'`). */
export function normalizarEstilo(valor: unknown): string {
  return typeof valor === 'string' && valor.trim() ? valor.trim().toLowerCase() : 'equilibrado';
}

/** Sufixo de saída para o estilo de resposta do agente. */
export function sufixoDeSaida(estilo?: unknown): string {
  const linha = normalizarEstilo(estilo) === 'conciso' ? MENSAGENS_CONCISO : MENSAGENS_PADRAO;
  return CABECALHO + linha + RODAPE;
}
