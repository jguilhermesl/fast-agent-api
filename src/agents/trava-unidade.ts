/**
 * Trava de unidade (`prompt_config.trava_unidade`, 17/11/2026; v3 depois de duas revisões do Codex no mesmo dia).
 *
 * Por quê: o Leandro (Quiroleve, Londrina e Ibiporã) reclamou 13 vezes no grupo de horário oferecido na
 * unidade errada ("hoje é terça-feira atendo em Londrina e o robô marca em Ibiporã", 09/06; "o robô diz
 * amanhã em Londrina, sendo que amanhã é quinta", 19/08) e, em 17/11, de terapia invertida marcada em
 * Londrina, onde a mesa não existe. A regra estava no prompt; o modelo escorrega. Aqui ela é código.
 *
 * Só texto, sem LLM e sem rede:
 *
 *  1. Data × unidade (`checarDataUnidade`). Cada data dd/mm da resposta é ligada à unidade do seu trecho.
 *     Se a agenda DESTE turno trouxe a data e não trouxe a unidade (ou trouxe a data sem vaga), é violação.
 *     Data que a agenda do turno não trouxe fica de fora (o guard de lastro cuida dela). Ligação ambígua
 *     (cidade antes e outra depois da data) não acusa.
 *
 *  2. Serviço × unidade (`checarServico`), para serviço que só existe em algumas unidades (invertida =
 *     Ibiporã), com o assunto na conversa:
 *       · `contradicao`: uma oração afirma o serviço na unidade proibida ("faço a invertida em Londrina",
 *         "mas faço também em Londrina"). Aviso em OUTRA oração não desfaz a contradição.
 *       · `aviso`: oferece horário (com data ou só hora) na unidade proibida sem dizer, na mesma frase da
 *         unidade, que lá não tem o serviço.
 *
 *  `aplicarSemModelo` resolve os dois sem LLM (o orquestrador chama depois da reescrita e de novo no fim do
 *  turno, depois de todos os guards): data errada → confirmação pelo evento criado no turno ou pedido do dia;
 *  contradição → tira a oração; falta de aviso → acrescenta o aviso fixo.
 *
 * Configuração (ausente ou inválida = trava desligada):
 *   "trava_unidade": {
 *     "modo": "enforce" | "shadow",
 *     "unidades": ["Londrina", "Ibiporã"],
 *     "servicos": [{ "gatilho": "invertid|mesa de invers|suspens|cabeca p(a)?ra baixo|ponta cabeca",
 *                    "unidades": ["Ibiporã"],
 *                    "aviso": "sem a mesa|nao tem (a )?mesa|so (faco |tem )?(a invertida )?em ibipor",
 *                    "aviso_texto": "Lá em Londrina a sessão é de quiropraxia, sem a mesa de inversão." }]
 *   }
 * Regex da configuração: só letras, números, espaço, "|", "(", ")", "?" e "-" (sem "+", "*", "{", "\"),
 * até 200 caracteres. Assim não há como montar padrão de backtracking exponencial (ReDoS).
 */

export interface ServicoRestrito {
  gatilho: string;
  unidades: string[];
  aviso: string;
  aviso_texto: string;
}

export interface TravaUnidadeConfig {
  modo: 'enforce' | 'shadow';
  /** Todas as unidades do agente: reconhece a cidade no texto mesmo quando a agenda do turno não a trouxe. */
  unidades: string[];
  servicos: ServicoRestrito[];
}

/** Datas da agenda do turno: "19/11" → unidades normalizadas com vaga nela (vazio = data consultada sem vaga). */
export type MapaAgenda = Map<string, Set<string>>;

export interface ViolacaoData {
  data: string;
  unidade: string;
  unidadesDaAgenda: string[];
  trecho: string;
}

export type ProblemaServico = ServicoRestrito & { tipo: 'aviso' | 'contradicao'; trecho: string };

/**
 * Minúscula, sem acento (NFD na string inteira, então emoji e surrogate ficam intactos) e hífen/sublinhado
 * viram espaço ("cabeça-pra-baixo"). Texto já composto (o normal no WhatsApp) mantém as posições.
 */
export function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[-_]/g, ' ');
}

const ddmm = (d: number, m: number) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regex de configuração aceitável: só alternativa, grupo e "?" sobre letras (sem "+", "*", "{" nem "\"),
 * até 200 caracteres, e compila. Com esse alfabeto o tempo de casar é linear: não há ReDoS possível.
 */
function regexSegura(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim() || p.length > 200) return false;
  if (!/^[\p{L}\p{N} |()?-]+$/u.test(p)) return false;
  try {
    new RegExp(p, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Lê a configuração do `prompt_config`; modo inválido = null (trava desligada). Serviço inválido é descartado. */
export function lerConfig(bruto: unknown): TravaUnidadeConfig | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const b = bruto as { modo?: unknown; servicos?: unknown; unidades?: unknown };
  const modo = b.modo === 'enforce' ? 'enforce' : b.modo === 'shadow' ? 'shadow' : null;
  if (!modo) return null;
  const servicos: ServicoRestrito[] = [];
  if (Array.isArray(b.servicos)) {
    for (const s of b.servicos as Array<Record<string, unknown>>) {
      if (!regexSegura(s?.gatilho) || !regexSegura(s?.aviso)) continue;
      if (typeof s.aviso_texto !== 'string' || !s.aviso_texto.trim()) continue;
      if (!Array.isArray(s.unidades) || !s.unidades.length || !s.unidades.every((u) => typeof u === 'string' && u.trim())) continue;
      servicos.push({ gatilho: s.gatilho, unidades: s.unidades as string[], aviso: s.aviso, aviso_texto: s.aviso_texto });
    }
  }
  const unidades = Array.isArray(b.unidades) ? b.unidades.filter((u): u is string => typeof u === 'string' && !!u.trim()) : [];
  return { modo, unidades, servicos };
}

/**
 * Procura `available_slots` em qualquer profundidade dos resultados das ferramentas do turno (o executor
 * embrulha o retorno da intenção em `data.data`, e às vezes o resultado vem como texto JSON).
 */
export function mapaDaAgenda(resultados: unknown[]): MapaAgenda {
  const mapa: MapaAgenda = new Map();
  const visitar = (o: unknown, prof: number) => {
    if (prof > 10 || o == null) return;
    if (typeof o === 'string') {
      const t = o.trim();
      if ((t.startsWith('{') || t.startsWith('[')) && t.includes('available_slots')) {
        try {
          visitar(JSON.parse(t), prof + 1);
        } catch {
          /* texto livre */
        }
      }
      return;
    }
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) visitar(x, prof + 1);
      return;
    }
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.available_slots)) {
      for (const dia of rec.available_slots as Array<Record<string, unknown>>) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dia?.date === 'string' ? dia.date : '');
        if (!m) continue;
        const chave = ddmm(Number(m[3]), Number(m[2]));
        const set = mapa.get(chave) ?? new Set<string>();
        if (Array.isArray(dia.slots_por_unidade)) {
          for (const s of dia.slots_por_unidade as Array<Record<string, unknown>>) {
            if (typeof s?.unidade === 'string' && s.unidade.trim()) set.add(normalizar(s.unidade.trim()));
          }
        }
        mapa.set(chave, set);
      }
    }
    for (const v of Object.values(rec)) visitar(v, prof + 1);
  };
  for (const r of resultados) visitar(r, 0);
  return mapa;
}

const RE_DATA = /\b(\d{1,2})\/(\d{1,2})\b/g;
/** Hora de oferta: "13h", "13h30", "13:00". Faixa de expediente ("das 10h às 20h", "até 19h") sai antes. */
const RE_HORA = /\b\d{1,2}(?:h\d{0,2}|:\d{2})\b/g;
const RE_FAIXA = /\b(?:das|de)\s+\d{1,2}(?:h\d{0,2}|:\d{2})?\s*(?:as|a|ate|-)\s*\d{1,2}(?:h\d{0,2}|:\d{2})?|\b(?:ate|a partir das?)\s+\d{1,2}(?:h\d{0,2}|:\d{2})?/g;
/**
 * Negação de OFERTA: só indisponibilidade ligada ao objeto da agenda ("não tem vaga", "não atendo", "não abre",
 * "indisponível", "não em Londrina"). "Não tem estacionamento", "não tenho Pix", "não esqueça a roupa" não
 * negam a oferta (achados do Codex, 17/11). "Fechado" fica de fora: "Fechado, tá marcado" é confirmação.
 */
const OBJ = '(?:vaga|vagas|horario|horarios|hora|livre|agenda|disponibilidade|atendimento|mais vaga|mais horario|nada|como|a mesa|mesa)';
const RE_NEGA = new RegExp(
  [
    `\\bnao (?:atendo|atende|abre|abro|abriu|trabalho|funciona|faco|fazemos|estou|vou estar|apareceu|aparece|sobrou)\\b`,
    `\\bnao (?:tem|tenho|ha|temos|consigo|encontrei|achei)(?: mais)? ${OBJ}\\b`,
    `\\bnao consigo (?:te )?(?:encaixar|atender|marcar|agendar)\\b`,
    `\\bnao (?:e )?(?:em|na|no|la em|aqui em)\\s`,
    `\\bsem (?:horario|vaga|a mesa)\\b`,
    `\\bindisponive`,
    `\\bnenhum`,
    `\\blotad`,
    `\\bocupad`,
  ].join('|'),
);

/** Apaga (com espaços, mantendo posições) as faixas de horário de expediente. */
const semFaixas = (n: string) => n.replace(RE_FAIXA, (m) => ' '.repeat(m.length));

interface Posicao {
  pos: number;
  fim: number;
}
const posicoes = (n: string, re: RegExp): Array<Posicao & { m: RegExpMatchArray }> =>
  [...n.matchAll(new RegExp(re.source, 'g'))].map((m) => ({ pos: m.index ?? 0, fim: (m.index ?? 0) + m[0].length, m }));

/**
 * A unidade em `u` está negada pelo texto próximo (até 30 caracteres antes e 40 depois)? A janela para em
 * qualquer outra cidade (`outras`): "18/11 em Ibiporã às 13h, em Londrina não tem vaga" nega Londrina, não
 * Ibiporã.
 */
function negada(n: string, u: Posicao, outras: Posicao[] = []): boolean {
  const antes = outras.filter((o) => o.fim <= u.pos).reduce((a, o) => Math.max(a, o.fim), 0);
  const depois = outras.filter((o) => o.pos >= u.fim).reduce((a, o) => Math.min(a, o.pos), n.length);
  return RE_NEGA.test(n.slice(Math.max(antes, u.pos - 30), Math.min(depois, u.fim + 40)));
}

/** Frases (pontuação final ou quebra de linha), cada uma com o texto normalizado. */
function frases(texto: string): Array<{ orig: string; n: string }> {
  return texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((orig) => ({ orig, n: normalizar(orig) }));
}

export interface ParDataUnidade {
  data: string;
  unidade: string;
  trecho: string;
  negado: boolean;
}

/**
 * Trechos de oferta dentro da frase: ";", " ou " e ", em <algo>" separam ofertas. "às 18h em Londrina; em
 * Ibiporã, a opção é 05/11" são duas ofertas (falso positivo real de 04/11 sem esta divisão).
 */
const trechosDaFrase = (n: string): string[] => n.split(/;|\s+ou\s+|,\s+(?=em\s)/).map((t) => t.trim()).filter(Boolean);

/**
 * Pares data → unidade escritos no texto. Dentro de cada trecho:
 *  - para cada data, candidatas: a unidade antes dela (não usada por outra data do trecho) e as unidades
 *    depois dela até a próxima data. Só uma das duas → usa. As duas, diferentes → ambíguo, não gera par;
 *  - data sem candidata herda a cidade da data vizinha do mesmo trecho ("Em Londrina tenho 18/11 às 13h e
 *    19/11 às 14h"; "Tenho 19/11 às 13h e 18/11 às 14h em Londrina");
 *  - trecho só com datas deixa as datas pendentes para a cidade do trecho seguinte ("Quinta, 19/11, às 13h,
 *    em Londrina") ou, se não vier, para a última cidade da frase ("Em Londrina tenho 18/11 às 13h ou 19/11");
 *  - trecho com cidade e hora mas sem data herda a última data ("21/11 às 15h em Ibiporã ou às 9h em
 *    Londrina");
 *  - linhas com data e sem cidade logo depois de uma frase terminada em ":" herdam a cidade dela ("Em
 *    Londrina tenho estas opções:" / "18/11 às 13h" / "19/11 às 14h").
 */
export function paresDataUnidade(texto: string, unidades: string[]): ParDataUnidade[] {
  const pares: ParDataUnidade[] = [];
  const unis = [...new Set(unidades.map((u) => normalizar(u.trim())).filter(Boolean))];
  if (!unis.length) return pares;
  const reUni = new RegExp(`\\b(${unis.map(esc).join('|')})\\b`, 'g');
  let herdada: string | null = null;
  for (const f of frases(texto)) {
    const usDaFrase = posicoes(f.n, reUni);
    if (!posicoes(f.n, RE_DATA).length) {
      herdada = usDaFrase.length && /:\s*$/.test(f.n) ? usDaFrase[usDaFrase.length - 1].m[1] : null;
      continue;
    }
    if (!usDaFrase.length) {
      // Linha de lista depois de "Em Londrina tenho estas opções:" — a herança continua na linha seguinte.
      if (herdada) for (const d of posicoes(f.n, RE_DATA)) pares.push({ data: ddmm(Number(d.m[1]), Number(d.m[2])), unidade: herdada, trecho: f.orig, negado: RE_NEGA.test(f.n) });
      continue;
    }
    herdada = null;
    let pendentes: string[] = [];
    let ultimaData: string | null = null;
    let ultimaCidade: string | null = null;
    for (const t of trechosDaFrase(f.n)) {
      const datas = posicoes(t, RE_DATA).map((d) => ({ ...d, data: ddmm(Number(d.m[1]), Number(d.m[2])) }));
      const us = posicoes(t, reUni).map((u) => ({ ...u, u: u.m[1] }));
      const par = (data: string, u: (typeof us)[number]) => {
        pares.push({ data, unidade: u.u, trecho: f.orig, negado: negada(t, u, us.filter((o) => o.pos !== u.pos)) });
      };
      if (us.length) ultimaCidade = us[us.length - 1].u;
      if (!datas.length) {
        if (!us.length) continue;
        if (pendentes.length) for (const d of pendentes) par(d, us[0]);
        else if (ultimaData && posicoes(semFaixas(t), RE_HORA).length) for (const u of us) par(ultimaData, u);
        pendentes = [];
        continue;
      }
      ultimaData = datas[datas.length - 1].data;
      if (!us.length) {
        pendentes = [...pendentes, ...datas.map((d) => d.data)];
        continue;
      }
      if (pendentes.length) for (const d of pendentes) par(d, us[0]);
      pendentes = [];
      const usadas = new Set<number>();
      const escolhaPorData: Array<(typeof us)[number][] | null | undefined> = datas.map((d, i) => {
        const fim = datas[i + 1]?.pos ?? Infinity;
        const ini = i > 0 ? datas[i - 1].fim : 0;
        const depois = us.filter((u) => u.pos > d.pos && u.pos < fim);
        const antes = [...us].reverse().find((u) => u.pos < d.pos && u.pos >= ini && !usadas.has(u.pos));
        if (depois.length && antes && depois.some((x) => x.u !== antes.u)) return null; // ambíguo
        const esc2 = depois.length ? depois : antes ? [antes] : undefined;
        for (const u of esc2 ?? []) usadas.add(u.pos);
        return esc2;
      });
      datas.forEach((d, i) => {
        let esc2 = escolhaPorData[i];
        if (esc2 === null) return; // ambíguo: não acusa
        if (!esc2) {
          // Sem candidata própria: a cidade da data vizinha do mesmo trecho (próxima, senão anterior).
          const viz = escolhaPorData.slice(i + 1).find((x) => x && x.length) ?? [...escolhaPorData.slice(0, i)].reverse().find((x) => x && x.length);
          esc2 = viz ? [viz[viz.length - 1]] : undefined;
        }
        for (const u of esc2 ?? []) par(d.data, u);
      });
    }
    // Datas que sobraram sem cidade: a última cidade dita na frase ("Em Londrina tenho 18/11 às 13h ou 19/11").
    if (pendentes.length && ultimaCidade) {
      for (const d of pendentes) pares.push({ data: d, unidade: ultimaCidade, trecho: f.orig, negado: false });
    }
  }
  return pares;
}

/** Checagem 1: data oferecida numa unidade que a agenda do turno não trouxe para essa data (ou sem vaga). */
export function checarDataUnidade(mensagens: string[], agenda: MapaAgenda, unidades: string[] = []): ViolacaoData[] {
  if (!agenda.size) return [];
  const todas = [...new Set([...[...agenda.values()].flatMap((s) => [...s]), ...unidades.map(normalizar)])];
  const out: ViolacaoData[] = [];
  for (const p of paresDataUnidade(mensagens.join('\n'), todas)) {
    const daAgenda = agenda.get(p.data);
    if (p.negado || !daAgenda) continue;
    if (!daAgenda.has(p.unidade)) out.push({ data: p.data, unidade: p.unidade, unidadesDaAgenda: [...daAgenda], trecho: p.trecho });
  }
  return out;
}

/** Orações da frase: separadas por vírgula, ";", " ou " e " mas ". "Em Londrina," curto junta com a seguinte. */
function oracoes(n: string): string[] {
  const partes = n.split(/[,;]|\s+ou\s+|\s+mas\s+/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < partes.length; i++) {
    if (/^(?:em|la em|aqui em|no|na)\s+\S+$/.test(partes[i]) && i + 1 < partes.length) {
      partes[i + 1] = `${partes[i]} ${partes[i + 1]}`;
      continue;
    }
    out.push(partes[i]);
  }
  return out;
}

/**
 * Checagem 2: serviço restrito em pauta. Devolve `contradicao` (alguma oração afirma o serviço na unidade
 * proibida) e `aviso` (ofereceu horário na unidade proibida sem dizer, na mesma frase da unidade, que lá não
 * tem o serviço).
 */
export function checarServico(input: {
  mensagens: string[];
  clientMessage: string;
  falasRecentesDoAgente: string[];
  agenda: MapaAgenda;
  servicos: ServicoRestrito[];
  unidades?: string[];
}): ProblemaServico[] {
  const resposta = input.mensagens.join('\n');
  const contexto = normalizar([input.clientMessage, resposta, ...input.falasRecentesDoAgente].join('\n'));
  const conhecidas = [...new Set([...[...input.agenda.values()].flatMap((s) => [...s]), ...(input.unidades ?? []).map(normalizar)])];
  const out: ProblemaServico[] = [];
  for (const s of input.servicos) {
    const gatilho = new RegExp(s.gatilho, 'i');
    if (!gatilho.test(contexto)) continue;
    const permitidas = new Set(s.unidades.map(normalizar));
    const todas = [...new Set([...conhecidas, ...permitidas])];
    const proibidas = todas.filter((u) => !permitidas.has(u));
    if (!proibidas.length) continue;
    const reProib = new RegExp(`\\b(${proibidas.map(esc).join('|')})\\b`, 'g');
    const reTodas = new RegExp(`\\b(${todas.map(esc).join('|')})\\b`, 'g');
    // Aviso válido: casa o padrão sem "não" logo antes ("não é só em Ibiporã" não é aviso).
    const avisoValido = (n: string) =>
      [...n.matchAll(new RegExp(s.aviso, 'gi'))].some((m) => !/\bnao (?:e )?$/.test(n.slice(Math.max(0, (m.index ?? 0) - 8), m.index)));
    let contradicao = false;
    let oferta = false;
    let avisou = false;
    for (const f of frases(resposta)) {
      const cidades = posicoes(f.n, reTodas);
      const ups = cidades.filter((c) => !permitidas.has(c.m[1]));
      if (!ups.length) continue;
      if (avisoValido(f.n)) avisou = true;
      // Contradição por oração: a oração tem a unidade proibida (não negada) e o serviço, ou diz "também"
      // numa frase que fala do serviço ("A invertida é só em Ibiporã, mas faço também em Londrina").
      for (const o of oracoes(f.n)) {
        const cid = posicoes(o, reTodas);
        const proibNaOracao = cid.filter((c) => !permitidas.has(c.m[1]));
        if (!proibNaOracao.length) continue;
        if (proibNaOracao.every((u) => negada(o, u, cid.filter((x) => x.pos !== u.pos)))) continue;
        if (gatilho.test(o) || (/\btambem\b/.test(o) && gatilho.test(f.n))) contradicao = true;
      }
      // Oferta: unidade proibida não negada, com data ou hora na frase.
      const n = semFaixas(f.n);
      const temHorario = posicoes(n, RE_DATA).length > 0 || posicoes(n, RE_HORA).length > 0;
      if (temHorario && ups.some((u) => !negada(f.n, u, cidades.filter((o) => o.pos !== u.pos)))) oferta = true;
    }
    if (contradicao) {
      out.push({ ...s, tipo: 'contradicao', trecho: resposta.slice(0, 300) });
      continue;
    }
    if (!oferta || avisou) continue;
    // Já avisou nas últimas falas (e a resposta atual não contradiz): não repete o aviso.
    if (input.falasRecentesDoAgente.some((x) => avisoValido(normalizar(x)))) continue;
    out.push({ ...s, tipo: 'aviso', trecho: resposta.slice(0, 300) });
  }
  return out;
}

/** Instrução da reescrita para a checagem 1. */
export function instrucaoDataUnidade(v: ViolacaoData[]): string {
  const itens = v
    .map((x) =>
      x.unidadesDaAgenda.length
        ? `${x.data} foi oferecido em ${x.unidade}, mas a agenda deste turno só tem ${x.data} em ${x.unidadesDaAgenda.join(' e ')}`
        : `${x.data} foi oferecido em ${x.unidade}, mas a agenda deste turno não tem vaga em ${x.data}`,
    )
    .join('; ');
  return (
    `CORREÇÃO OBRIGATÓRIA: na sua resposta, ${itens}. Reescreva usando só as datas e unidades que a agenda ` +
    'devolveu (slots_por_unidade). Cada horário vai com a unidade em que ele existe. Mantenha o resto da mensagem.'
  );
}

/** Instrução da reescrita para contradição de serviço. */
export function instrucaoServico(p: ProblemaServico[]): string {
  const itens = p.map((x) => `o serviço só existe em ${x.unidades.join(' e ')}`).join('; ');
  return (
    `CORREÇÃO OBRIGATÓRIA: sua resposta diz que o serviço é feito numa unidade onde ele não existe (${itens}). ` +
    `Reescreva sem dizer isso. Se oferecer horário em outra unidade, diga que lá a sessão é diferente: ${p[0]?.aviso_texto ?? ''}`
  );
}

/** Tira as frases que afirmam o serviço na unidade proibida (plano B quando a reescrita insiste ou não há tempo). */
export function tirarContradicoes(mensagens: string[], servicos: ServicoRestrito[], unidades: string[]): string[] {
  const contradiz = (fr: string) =>
    checarServico({ mensagens: [fr], clientMessage: '', falasRecentesDoAgente: [], agenda: new Map(), servicos, unidades }).some(
      (p) => p.tipo === 'contradicao',
    );
  return mensagens
    .map((m) =>
      MARCADOR.test(m)
        ? m
        : m
            .split(/(?<=[.!?])\s+|\n+/)
            .filter((fr) => !contradiz(fr))
            .join(' ')
            .trim(),
    )
    .filter((m) => m.length > 0);
}

const MARCADOR = /^\s*\[\[/;

/** Acrescenta o aviso ao fim da última mensagem de TEXTO (marcador de mídia "[[...]]" fica intacto). */
export function acrescentarAvisos(mensagens: string[], avisos: ServicoRestrito[]): string[] {
  if (!avisos.length) return mensagens;
  const textos = [...new Set(avisos.map((a) => a.aviso_texto))].join(' ');
  const out = [...mensagens];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!MARCADOR.test(out[i])) {
      out[i] = `${out[i].trimEnd()}\n${textos}`;
      return out;
    }
  }
  return [...out, textos];
}

const SEMANA: Record<string, string> = {
  domingo: 'domingo',
  'segunda-feira': 'segunda',
  'terça-feira': 'terça',
  'quarta-feira': 'quarta',
  'quinta-feira': 'quinta',
  'sexta-feira': 'sexta',
  sábado: 'sábado',
};
const FALHOU = (r: Record<string, unknown>) =>
  r.success === false || r.ok === false || (typeof r.status === 'string' && /^(error|erro|cancel|fail|falh)/i.test(r.status));

/**
 * Confirmação feita a partir do evento que a ferramenta de criação/atualização devolveu NESTE turno, no fuso
 * de Brasília. Só aceita evento único (nunca item de lista, que pode ser de outro paciente), sem nenhum
 * sinal de falha no caminho até ele, com data válida e local. Usada quando a resposta errou a unidade e não
 * deu para corrigir: o evento já existe, então pedir o dia de novo esconderia a consulta marcada.
 */
export function confirmacaoDoEvento(tools: Array<{ tool: string; result: unknown }>): string | null {
  for (const t of [...tools].reverse()) {
    if (!/criar_evento|atualizar_evento/.test(t.tool)) continue;
    let ev: { dateTime: string; location: string } | null = null;
    const achar = (o: unknown, prof: number): void => {
      if (ev || prof > 8 || o == null) return;
      if (typeof o === 'string') {
        const s = o.trim();
        if (s.startsWith('{')) {
          try {
            achar(JSON.parse(s), prof + 1);
          } catch {
            /* texto livre */
          }
        }
        return;
      }
      if (typeof o !== 'object' || Array.isArray(o)) return; // lista = outros eventos: nunca confirma por ela
      const r = o as Record<string, unknown>;
      if (FALHOU(r)) return;
      const st = r.start as { dateTime?: unknown } | undefined;
      if (st && typeof st.dateTime === 'string' && typeof r.location === 'string' && r.location.trim()) {
        ev = { dateTime: st.dateTime, location: r.location.trim() };
        return;
      }
      for (const v of Object.values(r)) achar(v, prof + 1);
    };
    achar(t.result, 0);
    const e = ev as { dateTime: string; location: string } | null;
    if (!e) continue;
    const quando = new Date(e.dateTime);
    if (Number.isNaN(quando.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(e.dateTime)) continue;
    const partes = Object.fromEntries(
      new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(quando)
        .map((p) => [p.type, p.value]),
    );
    const dia = SEMANA[String(partes.weekday).toLowerCase()] ?? String(partes.weekday);
    const hora = partes.minute === '00' ? `${Number(partes.hour)}h` : `${Number(partes.hour)}h${partes.minute}`;
    return `Fechado, tá marcado pra ${dia}, ${partes.day}/${partes.month} às ${hora} em ${e.location}!`;
  }
  return null;
}

/**
 * Aplica a trava sem LLM (o orquestrador chama depois da reescrita e de novo no fim do turno):
 *  - data × unidade errada → confirmação pelo evento do turno ou `mensagemPedeDia`;
 *  - contradição de serviço → tira a frase (e acrescenta o aviso);
 *  - oferta na unidade proibida sem aviso → acrescenta o aviso.
 * Devolve as mensagens finais e o que fez (vazio = nada a corrigir).
 */
export function aplicarSemModelo(input: {
  mensagens: string[];
  agenda: MapaAgenda;
  trava: TravaUnidadeConfig;
  clientMessage: string;
  falasRecentesDoAgente: string[];
  tools: Array<{ tool: string; result: unknown }>;
  mensagemPedeDia: string;
}): { mensagens: string[]; feito: string[]; violacoes: ViolacaoData[]; problemas: ProblemaServico[] } {
  let mensagens = input.mensagens;
  const feito: string[] = [];
  const violacoes = checarDataUnidade(mensagens, input.agenda, input.trava.unidades);
  if (violacoes.length) {
    const doEvento = confirmacaoDoEvento(input.tools);
    mensagens = [doEvento ?? input.mensagemPedeDia];
    feito.push(doEvento ? 'confirmou_evento' : 'pediu_dia');
  }
  const checar = (msgs: string[]) =>
    checarServico({
      mensagens: msgs,
      clientMessage: input.clientMessage,
      falasRecentesDoAgente: input.falasRecentesDoAgente,
      agenda: input.agenda,
      servicos: input.trava.servicos,
      unidades: input.trava.unidades,
    });
  let problemas = input.trava.servicos.length ? checar(mensagens) : [];
  const todosProblemas = problemas;
  const contradicoes = problemas.filter((p) => p.tipo === 'contradicao');
  if (contradicoes.length) {
    mensagens = tirarContradicoes(mensagens, input.trava.servicos, input.trava.unidades);
    feito.push('tirou_frase');
    problemas = mensagens.length ? checar(mensagens) : [];
  }
  const avisos = problemas.filter((p) => p.tipo === 'aviso');
  if (avisos.length || contradicoes.length) {
    mensagens = acrescentarAvisos(mensagens, avisos.length ? avisos : contradicoes);
    feito.push('aviso');
  }
  return { mensagens, feito, violacoes, problemas: todosProblemas };
}
