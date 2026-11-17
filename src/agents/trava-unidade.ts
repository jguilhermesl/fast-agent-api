/**
 * Trava de unidade (`prompt_config.trava_unidade`, 17/11/2026).
 *
 * Por quê: o Leandro (Quiroleve, Londrina e Ibiporã) reclamou 13 vezes no grupo de horário oferecido na
 * unidade errada ("hoje é terça-feira atendo em Londrina e o robô marca em Ibiporã", 09/06; "o robô diz
 * amanhã em Londrina, sendo que amanhã é quinta", 19/08) e, em 17/11, de terapia invertida marcada em
 * Londrina, onde a mesa não existe. A regra estava no prompt; o modelo escorrega. Aqui ela é código.
 *
 * Duas checagens, só texto, sem LLM e sem rede:
 *
 *  1. Data × unidade. A agenda (`google_calendar_horarios_disponiveis`) devolve `slots_por_unidade` por
 *     data. Cada data escrita na resposta ("19/11") é ligada à unidade citada perto dela, na mesma frase
 *     e no mesmo trecho entre "ou" (a primeira unidade depois da data; sem nenhuma, a última antes). Se a
 *     agenda DESTE turno trouxe essa data e não trouxe essa unidade nela, é violação. Data que a agenda do
 *     turno não trouxe fica de fora (o guard de lastro cuida dela).
 *
 *  2. Serviço × unidade. Serviço que só existe em algumas unidades (ex.: terapia invertida só em Ibiporã).
 *     Se o assunto está na conversa (fala nova do cliente, resposta ou as 2 últimas falas do agente) e a
 *     resposta oferece data numa unidade onde o serviço não existe, sem o aviso, o código acrescenta o
 *     aviso fixo da configuração. Não depende do modelo obedecer.
 *
 * Configuração (ausente = nada roda):
 *   "trava_unidade": {
 *     "modo": "enforce" | "shadow",
 *     "servicos": [{ "gatilho": "invertid|mesa de invers|suspens", "unidades": ["Ibiporã"],
 *                    "aviso": "sem a mesa|quiropraxia", "aviso_texto": "Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão." }]
 *   }
 */

export interface ServicoRestrito {
  gatilho: string;
  unidades: string[];
  aviso: string;
  aviso_texto: string;
}

export interface TravaUnidadeConfig {
  modo: 'enforce' | 'shadow';
  /** Todas as unidades do agente: acha a cidade no texto mesmo em turno sem consulta à agenda. */
  unidades: string[];
  servicos: ServicoRestrito[];
}

/** Datas da agenda do turno: "19/11" → unidades normalizadas com horário livre nela. */
export type MapaAgenda = Map<string, Set<string>>;

export interface ViolacaoData {
  data: string;
  unidade: string;
  unidadesDaAgenda: string[];
  trecho: string;
}

/** Minúscula e sem acento, char a char (mantém as posições do texto original). */
export function normalizar(s: string): string {
  let out = '';
  for (const c of s.toLowerCase()) out += c.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 1) || c;
  return out;
}

const ddmm = (d: number, m: number) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;

/** Lê a configuração do `prompt_config`; formato inválido = null (trava desligada). */
export function lerConfig(bruto: unknown): TravaUnidadeConfig | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const b = bruto as { modo?: unknown; servicos?: unknown; unidades?: unknown };
  const modo = b.modo === 'enforce' ? 'enforce' : b.modo === 'shadow' ? 'shadow' : null;
  if (!modo) return null;
  const servicos: ServicoRestrito[] = [];
  if (Array.isArray(b.servicos)) {
    for (const s of b.servicos as Array<Record<string, unknown>>) {
      if (typeof s?.gatilho !== 'string' || !Array.isArray(s.unidades) || typeof s.aviso !== 'string' || typeof s.aviso_texto !== 'string') continue;
      try {
        new RegExp(s.gatilho, 'i');
        new RegExp(s.aviso, 'i');
      } catch {
        continue;
      }
      servicos.push({ gatilho: s.gatilho, unidades: s.unidades.map(String), aviso: s.aviso, aviso_texto: s.aviso_texto });
    }
  }
  const unidades = Array.isArray(b.unidades) ? b.unidades.filter((u): u is string => typeof u === 'string' && !!u.trim()) : [];
  return { modo, unidades, servicos };
}

/**
 * Procura `available_slots` em qualquer profundidade dos resultados das ferramentas do turno
 * (o executor embrulha o retorno da intenção em `data.data`).
 */
export function mapaDaAgenda(resultados: unknown[]): MapaAgenda {
  const mapa: MapaAgenda = new Map();
  const visitar = (o: unknown, prof: number) => {
    if (!o || typeof o !== 'object' || prof > 8) return;
    if (Array.isArray(o)) {
      for (const x of o) visitar(x, prof + 1);
      return;
    }
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.available_slots)) {
      for (const dia of rec.available_slots as Array<Record<string, unknown>>) {
        const iso = typeof dia?.date === 'string' ? dia.date : '';
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!m || !Array.isArray(dia.slots_por_unidade)) continue;
        const chave = ddmm(Number(m[3]), Number(m[2]));
        const set = mapa.get(chave) ?? new Set<string>();
        for (const s of dia.slots_por_unidade as Array<Record<string, unknown>>) {
          if (typeof s?.unidade === 'string' && s.unidade.trim()) set.add(normalizar(s.unidade.trim()));
        }
        mapa.set(chave, set);
      }
    }
    for (const v of Object.values(rec)) if (v && typeof v === 'object') visitar(v, prof + 1);
  };
  for (const r of resultados) {
    if (typeof r === 'string') {
      try {
        visitar(JSON.parse(r), 0);
      } catch {
        /* texto livre: sem agenda */
      }
    } else visitar(r, 0);
  }
  return mapa;
}

const RE_DATA = /\b(\d{1,2})\/(\d{1,2})\b/g;
/**
 * Trecho que nega ("quinta, 12/11 em Londrina eu não atendo") não é oferta. Medido em 30 dias do Leandro
 * (1.818 turnos): 4 dos 5 disparos sem esta regra eram negação.
 */
// "fechado" fica de fora: "Fechado, tá marcado pra quarta" é confirmação, não negação.
const RE_NEGA = /\bnao\b|\bsem (horario|vaga)|\bnenhum/;

/** Trechos onde data e unidade andam juntas: frase, e dentro dela cada alternativa separada por "ou"/";". */
function trechos(texto: string): string[] {
  return texto
    .split(/[.!?\n]+/)
    .flatMap((f) => f.split(/\s+ou\s+|;/i))
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Pares data → unidade escritos na resposta. */
export function paresDataUnidade(
  texto: string,
  unidades: string[],
): Array<{ data: string; unidade: string; trecho: string; negado: boolean }> {
  const pares: Array<{ data: string; unidade: string; trecho: string; negado: boolean }> = [];
  if (!unidades.length) return pares;
  const reUni = new RegExp(`\\b(${unidades.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
  for (const t of trechos(texto)) {
    const n = normalizar(t);
    const datas = [...n.matchAll(RE_DATA)].map((m) => ({ pos: m.index ?? 0, data: ddmm(Number(m[1]), Number(m[2])) }));
    if (!datas.length) continue;
    const unis = [...n.matchAll(reUni)].map((m) => ({ pos: m.index ?? 0, u: m[1] }));
    if (!unis.length) continue;
    datas.forEach((d, i) => {
      const fim = datas[i + 1]?.pos ?? Infinity;
      const depois = unis.find((u) => u.pos > d.pos && u.pos < fim);
      const antes = [...unis].reverse().find((u) => u.pos < d.pos);
      const u = depois ?? antes;
      if (u) pares.push({ data: d.data, unidade: u.u, trecho: t, negado: RE_NEGA.test(n) });
    });
  }
  return pares;
}

/** Checagem 1: data oferecida numa unidade que a agenda do turno não trouxe para essa data. */
export function checarDataUnidade(mensagens: string[], agenda: MapaAgenda): ViolacaoData[] {
  if (!agenda.size) return [];
  const unidades = [...new Set([...agenda.values()].flatMap((s) => [...s]))];
  const out: ViolacaoData[] = [];
  for (const p of paresDataUnidade(mensagens.join('\n'), unidades)) {
    const daAgenda = agenda.get(p.data);
    if (p.negado || !daAgenda || daAgenda.size === 0) continue;
    if (!daAgenda.has(p.unidade)) out.push({ data: p.data, unidade: p.unidade, unidadesDaAgenda: [...daAgenda], trecho: p.trecho });
  }
  return out;
}

/**
 * Checagem 2: serviço restrito em pauta + data oferecida em unidade sem o serviço + sem aviso na resposta.
 * Devolve os serviços cujo aviso precisa ser acrescentado.
 */
export function checarServico(input: {
  mensagens: string[];
  clientMessage: string;
  falasRecentesDoAgente: string[];
  agenda: MapaAgenda;
  servicos: ServicoRestrito[];
  unidades?: string[];
}): ServicoRestrito[] {
  const resposta = input.mensagens.join('\n');
  const contexto = [input.clientMessage, resposta, ...input.falasRecentesDoAgente].join('\n');
  const unidadesConhecidas = [...new Set([...[...input.agenda.values()].flatMap((s) => [...s]), ...(input.unidades ?? []).map(normalizar)])];
  const faltando: ServicoRestrito[] = [];
  for (const s of input.servicos) {
    if (!new RegExp(s.gatilho, 'i').test(normalizar(contexto)) && !new RegExp(s.gatilho, 'i').test(contexto)) continue;
    if (new RegExp(s.aviso, 'i').test(resposta) || new RegExp(s.aviso, 'i').test(normalizar(resposta))) continue;
    // Já avisou nas últimas falas: não repete (o Leandro reclamou de mensagem repetida em 10/11).
    const recentes = input.falasRecentesDoAgente.join('\n');
    if (new RegExp(s.aviso, 'i').test(recentes) || new RegExp(s.aviso, 'i').test(normalizar(recentes))) continue;
    const permitidas = new Set(s.unidades.map(normalizar));
    const todas = unidadesConhecidas.length ? unidadesConhecidas : [...permitidas];
    // Só a data escrita conta como oferta; citar a cidade solta ("sou de Londrina") não.
    const ofereceOutra = paresDataUnidade(resposta, [...new Set([...todas, ...permitidas])]).some((p) => !p.negado && !permitidas.has(p.unidade));
    if (ofereceOutra) faltando.push(s);
  }
  return faltando;
}

/** Instrução da reescrita para a checagem 1. */
export function instrucaoDataUnidade(v: ViolacaoData[]): string {
  const itens = v
    .map((x) => `${x.data} foi oferecido em ${x.unidade}, mas a agenda deste turno só tem ${x.data} em ${x.unidadesDaAgenda.join(' e ')}`)
    .join('; ');
  return (
    `CORREÇÃO OBRIGATÓRIA: na sua resposta, ${itens}. Reescreva usando só as datas e unidades que a agenda ` +
    'devolveu (slots_por_unidade). Cada horário vai com a unidade em que ele existe. Mantenha o resto da mensagem.'
  );
}

/** Acrescenta o aviso do serviço ao fim da última mensagem de texto. */
export function acrescentarAvisos(mensagens: string[], avisos: ServicoRestrito[]): string[] {
  if (!avisos.length || !mensagens.length) return mensagens;
  const textos = avisos.map((a) => a.aviso_texto).join(' ');
  const out = [...mensagens];
  out[out.length - 1] = `${out[out.length - 1].trimEnd()}\n${textos}`;
  return out;
}
