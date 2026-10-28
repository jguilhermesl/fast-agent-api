// Tarefa pedida pelo nome da intenção e não executada (`prompt_config.executor_confere_tarefas: true`).
//
// O Executor sai do laço quando o modelo para de chamar ferramenta e escreve o relatório. Na Canda
// (27–28/10/2026), com três tarefas no turno do descarte (etapa do painel, ficha, "Encerrar conversa"),
// ele executou uma ou duas em ~1 de 4 rodadas, com gpt-5.4-mini e com claude-haiku-5-5, e às vezes
// escreveu "Conversa encerrada" sem ter chamado a intenção. Sem o encerramento, o follow-up volta a
// chamar quem foi descartado.
//
// Só conta tarefa cujo `objetivo` COMEÇA com o nome ou o slug da intenção ("Encerrar conversa",
// "Atualizar ficha no CRM (atualizar_ficha) com etapa perdido"): "Não acionar Encerrar conversa" não
// começa com o nome e não é cobrada.

export interface IntencaoNomeada {
  name?: string;
  slug: string;
}

const normalizar = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function intencoesEsquecidas(
  query: string | undefined,
  intents: IntencaoNomeada[],
  chamadas: string[],
): IntencaoNomeada[] {
  if (!query) return [];
  let tarefas: unknown;
  try {
    tarefas = JSON.parse(query);
  } catch {
    return [];
  }
  if (!Array.isArray(tarefas)) return [];

  const feitas = new Set(chamadas);
  const faltam = new Map<string, IntencaoNomeada>();
  for (const t of tarefas) {
    if (!t || typeof t !== 'object') continue;
    const objetivo = normalizar(String((t as Record<string, unknown>).objetivo ?? ''));
    if (!objetivo) continue;
    for (const intent of intents) {
      if (feitas.has(intent.slug)) continue;
      const nome = normalizar(intent.name ?? '');
      const slug = normalizar(intent.slug);
      if ((nome && objetivo.startsWith(nome)) || (slug && objetivo.startsWith(slug))) faltam.set(intent.slug, intent);
    }
  }
  return [...faltam.values()];
}

export function cobrancaDeTarefas(faltam: IntencaoNomeada[]): string {
  const lista = faltam.map((i) => (i.name ? `"${i.name}" (${i.slug})` : i.slug)).join(', ');
  return (
    `Faltou executar: ${lista}. Essas tarefas estão em <tarefas> e ainda não foram chamadas neste turno. ` +
    'Chame agora a ferramenta de cada uma, com os dados das tarefas, e só depois escreva o relatório. ' +
    'Não repita o que já foi executado e não relate como feito o que não chamou.'
  );
}
