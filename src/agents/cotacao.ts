/**
 * Cotação no código: valor, valor no Pix e datas saem do retorno da busca, não do modelo.
 *
 * Por quê (Duda, outubro/2026): o modelo redigitava preço e data que a busca trouxe e,
 * de vez em quando, trocava. Preventivo cotado a R$ 100 com a busca dizendo R$ 150 e
 * datas que não existiam (13/10); em 30 dias, ao menos 6 preços inventados. A trava de
 * `guard.ts` barra depois do fato; aqui o número nem passa pelo modelo.
 *
 * Contrato com o modelo (instrução em `INSTRUCAO_COTACAO`, só para agente com a chave
 * `prompt_config.cotacao_no_codigo`): em vez de digitar, ele escreve
 *   {{preco:NOME DO ITEM}}  → o campo `preco` do item, como a planilha escreveu
 *   {{pix:NOME DO ITEM}}    → o campo `precoPix`; sem ele, a LINHA inteira sai
 *   {{datas:NOME DO ITEM}}  → bloco de datas agrupado por profissional
 * e este módulo troca pelo texto do item que a busca devolveu NESTE turno.
 *
 * Funções puras: sem rede, sem env. Quem chama decide o que fazer com marcador que não
 * achou item (orchestrator.ts pede uma reescrita e, se insistir, transfere).
 */

export interface DisponibilidadeCotacao {
  'data/horario'?: string;
  profissional?: string;
}

export interface ItemCotacao {
  nome: string;
  preco: string | null;
  precoPix: string | null;
  disponibilidades: DisponibilidadeCotacao[];
  ferramenta: string;
}

export interface ResultadoCotacao {
  mensagens: string[];
  /** Marcadores que não acharam item, como o modelo escreveu (ex.: "preco:Raio-X do joelho"). */
  naoResolvidos: string[];
  /** Quantos marcadores foram preenchidos. */
  resolvidos: number;
}

export const INSTRUCAO_COTACAO = `

# VALORES E DATAS: O SISTEMA ESCREVE
Valor, valor no Pix e datas de item que a busca trouxe neste turno você NÃO digita. Escreva o marcador e o sistema troca pelo texto exato da planilha:
- \`{{preco:NOME DO ITEM}}\`: o valor, já com o parcelamento que a planilha tiver.
- \`{{pix:NOME DO ITEM}}\`: o valor no Pix ou dinheiro. Se o item não tiver, a linha inteira some, então deixe esse marcador sozinho na linha.
- \`{{datas:NOME DO ITEM}}\`: o bloco de datas, com o profissional (e "Dr."/"Dra." quando for médico), o dia e o horário. Quando a regra do item limita o profissional (parecer para concurso, idade, especialidade), use \`{{datas:NOME DO ITEM|NOME DO PROFISSIONAL}}\` e só as datas dele saem.
Use o nome do item EXATAMENTE como veio no retorno da busca (copie), principalmente quando houver itens parecidos, como adulto e infantil. Não escreva "R$", dia/mês nem horário desses itens fora do marcador, e não repita o parcelamento depois do \`{{preco:...}}\`.
Valor que você calcula (soma de dois itens, total com desconto) ou que está escrito no seu prompt continua escrito por você.
Exemplo:
"Clínico Geral\\n\\n• Valor: {{preco:Clínico Geral}}\\n💰 DINHEIRO/PIX: {{pix:Clínico Geral}} À VISTA\\n\\nDatas disponíveis:\\n{{datas:Clínico Geral}}"`;

const MARCADOR = /\{\{\s*(preco|preço|valor|pix|datas)\s*:\s*([^}]+?)\s*\}\}/gi;
/** Qualquer resto de marcador ({{, }}), bem formado ou não: a linha com ele nunca vai ao paciente. */
export const RESTO_DE_MARCADOR = /\{\{|\}\}/;

const normalizar = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const textoOuNulo = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

/**
 * Itens que as ferramentas de busca devolveram no turno: todo objeto com `nome` e
 * `preco` num resultado em lista (conferir_especialidades, exames de sangue, combos,
 * LP Benefícios). Ferramenta de ação (texto pronto, CRM, agendamento) não entra.
 */
export function catalogoDoTurno(toolsCalled: Array<{ tool: string; result: unknown }>): ItemCotacao[] {
  const itens: ItemCotacao[] = [];
  for (const chamada of toolsCalled) {
    let r: unknown = chamada.result;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch { continue; }
    }
    // O intent-dispatcher embrulha: {status, http_status, data: {success, intent, data: [itens]}}.
    // Desce por `data` até achar a lista (no máximo 4 níveis).
    let lista: unknown[] | null = null;
    for (let nivel = 0; nivel < 4 && r && typeof r === 'object'; nivel++) {
      if (Array.isArray(r)) { lista = r; break; }
      r = (r as { data?: unknown }).data;
    }
    if (!lista && Array.isArray(r)) lista = r;
    if (!lista) continue;
    for (const bruto of lista) {
      if (!bruto || typeof bruto !== 'object') continue;
      const x = bruto as Record<string, unknown>;
      const nome = textoOuNulo(x.nome);
      if (!nome) continue;
      itens.push({
        nome,
        preco: textoOuNulo(x.preco),
        precoPix: textoOuNulo(x.precoPix),
        disponibilidades: Array.isArray(x.disponibilidades)
          ? (x.disponibilidades as unknown[]).filter((d): d is DisponibilidadeCotacao => !!d && typeof d === 'object')
          : [],
        ferramenta: chamada.tool,
      });
    }
  }
  return itens;
}

/** Palavras que não distinguem um item de outro. */
const PALAVRAS_VAZIAS = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'com', 'para', 'o', 'a', 'em', 'no', 'na']);
/** Palavras genéricas que o modelo acrescenta ao nome ("ultrassom do joelho", "consulta com clínico"). */
const GENERICAS = new Set(['ultrassom', 'usg', 'exame', 'exames', 'consulta', 'valor', 'teste', 'procedimento']);

const palavras = (s: string): string[] => normalizar(s).split(' ').filter((w) => w.length > 1 && !PALAVRAS_VAZIAS.has(w));

/**
 * Acha o item pelo nome que o modelo escreveu. Sem chute, porque o preço errado é
 * pior que pedir reescrita:
 *   1. nome igual (normalizado);
 *   2. todas as palavras distintivas do pedido estão no nome do item → o mais curto
 *      ("USG abdome total" → "ULTRASSOM/USG ABDOME TOTAL", não "… COM DOPPLER");
 *   3. o nome do item inteiro está no pedido e o que sobra são palavras genéricas
 *      ("ultrassom do Clínico Geral"? não; "consulta Clínico Geral" → "Clínico Geral").
 * "Raio-X do joelho" com só "Raio-X do tornozelo" no catálogo = não acha.
 * "Colesterol LDL" com "Colesterol" e "Colesterol HDL" = não acha.
 */
export function acharItem(pedido: string, catalogo: ItemCotacao[]): ItemCotacao | null {
  const p = normalizar(pedido);
  if (!p) return null;
  const iguais = catalogo.filter((i) => normalizar(i.nome) === p);
  if (iguais.length) return iguais[0];

  // Nome de item da planilha é lista de apelidos ("Psiquiatria, Psiquiatra, atestado físico
  // e mental", "ULTRASSOM/USG ABDOME TOTAL"): apelido igual ao pedido decide.
  const porApelido = catalogo.filter((i) => i.nome.split(/[,/|]/).some((a) => normalizar(a) === p));
  if (porApelido.length === 1) return porApelido[0];

  const doPedido = palavras(pedido);
  if (!doPedido.length) return null;

  const contemTudo = catalogo.filter((i) => {
    const doItem = new Set(palavras(i.nome));
    return doPedido.every((w) => doItem.has(w));
  });
  // Mais de um item com todas as palavras ("Psiquiatria" → adulto e infantil) é ambíguo:
  // não acha, e a reescrita mostra a lista para o modelo escolher o nome exato.
  if (contemTudo.length === 1) return contemTudo[0];
  if (contemTudo.length > 1) {
    const distintos = new Set(contemTudo.map((i) => normalizar(i.nome)));
    return distintos.size === 1 ? contemTudo[0] : null;
  }

  const setPedido = new Set(doPedido);
  const contidoNoPedido = catalogo.filter((i) => {
    const doItem = palavras(i.nome);
    if (!doItem.length || !doItem.every((w) => setPedido.has(w))) return false;
    const setItem = new Set(doItem);
    return doPedido.every((w) => setItem.has(w) || GENERICAS.has(w));
  });
  if (contidoNoPedido.length === 1) return contidoNoPedido[0];
  return null;
}

const DIA_DA_SEMANA: Record<string, string> = {
  segunda: 'Segunda-feira', terca: 'Terça-feira', quarta: 'Quarta-feira', quinta: 'Quinta-feira',
  sexta: 'Sexta-feira', sabado: 'Sábado', domingo: 'Domingo',
};

/** "11:00" → "11h"; "10:30" → "10h30"; "08h" → "08h"; "09h30" → "09h30". */
function hora(h: string): string {
  const m = h.trim().match(/^([0-2]?\d)\s*(?:h|:)\s*([0-5]\d)?\s*h?$/i);
  if (!m) return h.trim();
  return m[2] && m[2] !== '00' ? `${m[1]}h${m[2]}` : `${m[1]}h`;
}

/**
 * "segunda, 19/10/2026 - 11:00 - Ordem de chegada" → "Segunda-feira, 19/10 às 11h (ordem de chegada)".
 * Formato que não reconhece sai como veio (é texto da agenda, nunca inventado).
 */
export function linhaDeData(bruto: string): string {
  const texto = bruto.replace(/\s+/g, ' ').trim();
  const m = texto.match(/^([A-Za-zÀ-ÿç]+)\s*,\s*(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\s*(?:-\s*(.*))?$/);
  if (!m) return texto;
  const dia = DIA_DA_SEMANA[normalizar(m[1])] ?? m[1];
  const data = `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  let resto = (m[4] ?? '').trim();
  if (!resto) return `${dia}, ${data}`;

  let modalidade = '';
  const ordem = resto.match(/-?\s*ordem de chegada\s*$/i);
  if (ordem) {
    modalidade = ' (ordem de chegada)';
    resto = resto.slice(0, ordem.index).replace(/[-\s]+$/, '').trim();
  }
  if (!resto) return `${dia}, ${data}${modalidade}`;

  const faixa = resto.match(/^([0-2]?\d\s*(?:h|:)\s*[0-5]?\d?\s*h?)\s*(?:as|às|a|-)\s*([0-2]?\d\s*(?:h|:)\s*[0-5]?\d?\s*h?)$/i);
  if (faixa) return `${dia}, ${data} das ${hora(faixa[1])} às ${hora(faixa[2])}${modalidade}`;
  const unica = resto.match(/^[0-2]?\d\s*(?:h|:)\s*[0-5]?\d?\s*h?$/i);
  if (unica) return `${dia}, ${data} às ${hora(resto)}${modalidade}`;

  // "Hora marcada (a equipe confirma o horário)", "(hora marcada)", "Quartas-feiras (…)".
  let limpo = resto.trim();
  if (/^\(.*\)$/.test(limpo)) limpo = limpo.slice(1, -1);
  limpo = limpo.replace(/\s*\(\s*/g, ', ').replace(/\s*\)\s*/g, '').trim();
  return `${dia}, ${data} (${limpo.charAt(0).toLowerCase()}${limpo.slice(1)})${modalidade}`;
}

/** "Dr. Edson José" quando a lista do agente diz que é médico; senão o nome como veio. */
export function nomeComTitulo(nome: string, titulos: Record<string, string>): string {
  const n = nome.trim();
  if (/^(dr|dra)\.?\s/i.test(n)) return n;
  const chave = Object.keys(titulos).find((k) => normalizar(k) === normalizar(n));
  const titulo = chave ? titulos[chave]?.trim() : '';
  return titulo ? `${titulo} ${n}` : n;
}

/** Bloco de datas agrupado por profissional, na ordem em que a agenda trouxe. */
export function blocoDeDatas(item: ItemCotacao, titulos: Record<string, string>, so?: string): string {
  const lista = so
    ? item.disponibilidades.filter((d) => normalizar(String(d.profissional ?? '')).includes(normalizar(so)) || normalizar(so).includes(normalizar(String(d.profissional ?? '-'))))
    : item.disponibilidades;
  if (!lista.length) return so ? `Sem data aberta com ${nomeComTitulo(so, titulos)} na agenda no momento.` : 'Sem data aberta na agenda no momento.';
  const grupos = new Map<string, string[]>();
  for (const d of lista) {
    const prof = String(d.profissional ?? '').trim();
    const chave = prof && prof !== '-' ? nomeComTitulo(prof, titulos) : '';
    const linha = `• ${linhaDeData(String(d['data/horario'] ?? ''))}`;
    const lista = grupos.get(chave) ?? [];
    if (!lista.includes(linha)) lista.push(linha);
    grupos.set(chave, lista);
  }
  // Datas sem profissional vão primeiro: no meio, ficariam coladas sob o médico anterior.
  const entradas = [...grupos.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0));
  return entradas.map(([prof, linhas]) => (prof ? `${prof}\n${linhas.join('\n')}` : linhas.join('\n'))).join('\n');
}

/** Troca os marcadores das mensagens pelo texto dos itens do turno. */
export function resolverMarcadores(
  mensagens: string[],
  catalogo: ItemCotacao[],
  titulos: Record<string, string> = {},
): ResultadoCotacao {
  const naoResolvidos: string[] = [];
  let resolvidos = 0;
  const saida = mensagens.map((msg) =>
    msg
      .split('\n')
      .map((linha) => {
        let some = false;
        const nova = linha.replace(MARCADOR, (bruto, tipoBruto: string, nomeBruto: string) => {
          // {{datas:ITEM|PROFISSIONAL}}: só as datas daquele profissional.
          const [nome, so] = nomeBruto.split('|').map((x) => x.trim());
          const tipoLido = normalizar(tipoBruto);
          const tipo = tipoLido === 'valor' ? 'preco' : tipoLido;
          const item = acharItem(nome, catalogo);
          if (!item) { naoResolvidos.push(`${tipo}:${nome}`); return bruto; }
          if (tipo === 'preco') {
            if (!item.preco) { naoResolvidos.push(`${tipo}:${nome}`); return bruto; }
            resolvidos++;
            return item.preco;
          }
          if (tipo === 'pix') {
            if (!item.precoPix) { some = true; return ''; }
            resolvidos++;
            return item.precoPix;
          }
          resolvidos++;
          return blocoDeDatas(item, titulos, tipo === 'datas' && so ? so : undefined);
        });
        return some ? null : nova;
      })
      .filter((l): l is string => l !== null)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  ).filter((m) => m.length > 0);
  return { mensagens: saida, naoResolvidos, resolvidos };
}

/** A resposta tem algum marcador? (barato: evita montar catálogo em turno sem cotação). */
export function temMarcador(mensagens: string[]): boolean {
  MARCADOR.lastIndex = 0;
  return mensagens.some((m) => RESTO_DE_MARCADOR.test(m));
}
