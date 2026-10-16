/**
 * Trava do "texto fixo vizinho".
 *
 * Medido em 16/10/2026 na Duda (14 dias): o Orquestrador pediu
 * `enviar_detalhes_morfologica`, que não existe, e o Executor disparou a intenção
 * mais parecida, `enviar_detalhes_ecocardiograma`, para ~6 gestantes que queriam a
 * ultrassom morfológica — texto, local e valor de outro exame, entregues direto ao
 * cliente, sem como desfazer. O mesmo padrão foi anotado em 20/09 com `_psiquiatria`
 * e `_holter`. A regra do prompt ("nunca acione o texto de outro assunto por falta
 * de opção melhor") existe e não segurou o gpt-5.4-mini.
 *
 * A trava é estreita de propósito: só age quando a tarefa CITA pelo nome um
 * `enviar_detalhes_*` que não existe entre as intents do agente e o modelo tenta
 * disparar OUTRO `enviar_detalhes_*` que a tarefa não citou. Tarefa sem nome de
 * intent, intent citada que existe e ferramenta de busca passam como antes.
 */
const NOME_DE_TEXTO_FIXO = /enviar_detalhes_[a-z0-9_]+/g;

export function textoFixoVizinho(opcoes: {
  tarefa: string;
  ferramenta: string;
  intentsDoAgente: Set<string>;
}): string | null {
  if (!opcoes.ferramenta.startsWith('enviar_detalhes_')) return null;
  const citadas = new Set(opcoes.tarefa.match(NOME_DE_TEXTO_FIXO) ?? []);
  if (citadas.has(opcoes.ferramenta)) return null;
  const inexistentes = [...citadas].filter((slug) => !opcoes.intentsDoAgente.has(slug));
  if (!inexistentes.length) return null;
  return (
    `Bloqueado: a tarefa pede ${inexistentes.join(', ')}, que não existe entre as intents deste agente: ` +
    `esse item não tem texto fixo. ${opcoes.ferramenta} é o texto de outro assunto e não substitui. ` +
    `Busque o item pedido na intent de busca adequada (ex.: conferir_especialidades) ou devolva TAREFA_NAO_EXECUTADA.`
  );
}
