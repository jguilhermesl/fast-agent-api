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
 *
 * Nome errado do MESMO assunto não é vizinho. Em 16/10/2026 08:43 a tarefa pediu
 * `enviar_detalhes_oftalmologia` (o slug é `enviar_detalhes_oftalmo`), a trava
 * barrou o texto certo e a paciente foi transferida com o motivo "texto oficial da
 * oftalmologia não pôde ser acionado". Por isso, se a citada inexistente e a
 * ferramenta têm uma palavra de mesmo radical (7 letras: oftalmologia/oftalmo,
 * paternidade, implanon, beneficios), passa. Morfológica × ecocardiograma,
 * psiquiatria × reumatologia, sexagem × teste_do_pezinho e neuropediatra ×
 * neuropsicologa não têm, e seguem barrados.
 */
const NOME_DE_TEXTO_FIXO = /enviar_detalhes_[a-z0-9_]+/g;
const PALAVRAS_VAZIAS = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'o', 'a', 'teste', 'exame', 'consulta', 'texto', 'sobre', 'com']);
const RADICAL = 7;

function palavras(slug: string): string[] {
  return slug.replace(/^enviar_detalhes_/, '').split('_').filter((p) => p.length >= 4 && !PALAVRAS_VAZIAS.has(p));
}

/** As duas intents falam do mesmo assunto (uma palavra com o mesmo radical)? */
export function mesmoAssunto(a: string, b: string): boolean {
  const pb = palavras(b);
  return palavras(a).some((x) => pb.some((y) => {
    const n = Math.min(RADICAL, x.length, y.length);
    return n >= 5 && x.slice(0, n) === y.slice(0, n);
  }));
}

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
  if (inexistentes.some((slug) => mesmoAssunto(slug, opcoes.ferramenta))) return null;
  return (
    `Bloqueado: a tarefa pede ${inexistentes.join(', ')}, que não existe entre as intents deste agente: ` +
    `esse item não tem texto fixo. ${opcoes.ferramenta} é o texto de outro assunto e não substitui. ` +
    `Busque o item pedido na intent de busca adequada (ex.: conferir_especialidades) ou devolva TAREFA_NAO_EXECUTADA.`
  );
}
