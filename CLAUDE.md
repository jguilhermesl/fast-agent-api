# fast-agent-api

**Doc principal: `CONTEXT.md`** (fluxo, prompt em duas camadas, executor, memória). Ler antes de mexer.

## Cartão

| | |
|---|---|
| Repo | `jguilhermesl/fast-agent-api`, branch `master` |
| Deploy | Railway, `https://fast-agent-api.up.railway.app`. **Push em `master` publica.** `GET /api/version` devolve o commit no ar: comparar com `git rev-parse master`. Token: `RAILWAY_TOKEN_FAST_AGENT_API` em `C:\Users\Usuario\.claude\.env.local` |
| Mundo | Backend LLM da **Plataforma Agents**: o `AGENTE BASE` do n8n chama `/api/chat` e manda a resposta por `/api/send-external`; o `messaging-gateway` do `../chat-flow-pilot-63` chama `/api/add-context`. Nasceu na Fast IA legada (Chatwoot), cujo código de entrada já foi apagado. Mapa geral e estado atual: `../CLAUDE.md` |
| Stack | Node + TypeScript + Express · Redis · Supabase (`agents`, `leads`, `intent_execution_logs`) · OpenAI/Anthropic. Rotas `/api/chat`, `/api/stages`, `/api/send-external`, `/api/add-context`, `/api/typing`, `/api/version` |

## Comandos

```bash
npm run dev | build | start         # tsx watch src/index.ts · tsc · node dist/index.js
npm run lint | typecheck | test     # test = vitest run
npm run test:smoke   # tsx scripts/smoke-http.ts
```

Env obrigatória (só nomes, `src/config/index.ts`): `API_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `WEBHOOK_SECRET`. Opcional: `REDIS_URL`,
`ZAPI_CLIENT_TOKEN`, `GUARD_MODE`, `CRUZAMENTO_MODE`, `RAJADA_MODE`, `MONTADOR_SOMBRA`. Qual Supabase está no env do Railway: não verificado.

Estado das chaves no Railway (conferido em 30/09/2026):
- `API_SECRET` é o placeholder `your-secret-key-here` e autentica `/api/chat` e `/api/send-external`. A troca
  foi adiada pelo dono; ver `../CLAUDE.md`.
- `ANTHROPIC_API_KEY` dá 401. Agentes com modelo Claude (Priscila, Dani) caem em `gpt-4.1-mini` sem aviso.
- `OPENAI_API_KEY` tem de ser a mesma do secret do Supabase e do `.env.local`.

## Como um turno funciona hoje (30/09/2026)

- **Orquestrador** (`src/agents/orchestrator.ts`): modelo = `prompt_config.model_name` do agente; rodada 0 com
  `tool_choice: required` (força o executor, exceto saudação), depois `auto`.
  - A rodada 2 não reaproveita o cache da rodada 1.
  - Teste pago de 30/09 (`../estudo-20260930/execucao-cache-e-credito.md`): nem `tool_choice` igual, nem
    `prompt_cache_key`, nem retenção de 24 h mudam o resultado (≤ US$ 2,6/mês). Não mexer por custo.
- **Executor** (`src/agents/executor.ts`): `gpt-5.4-mini` fixo. Não vê o `system_prompt` do agente; vê as
  ferramentas e as `trigger_description`.
- **Recusa × objeção** (`src/agents/objecao.ts`, `9cdc7d3`): "não quero", "não tenho interesse" e
  "não, obrigada" são recusa (acolhe, não insiste, porta aberta uma vez). "Tá caro" e "é longe" continuam
  objeção.
- **`valor` do agendamento é preço** (`dc513a7`). Antes a descrição dizia data/hora e 27 de 138 agendamentos da
  Duda saíram com data no campo.
- **Formato da resposta** respeita `prompt_config.response_style` (`dc513a7`): `conciso` = uma mensagem curta
  salvo necessidade real; os outros estilos recebem o texto antigo byte a byte.
- **Base de conhecimento** (`8e30dfd`): RPC `buscar_conhecimento` (vetor + palavra, por fatia) com corte
  `prompt_config.kb.corte_hibrido`. `match_documents` fica como reserva.
- **Uma resposta por rajada** (`src/agents/rajada.ts`): no fim do turno, se o cliente mandou fala nova que não está
  no lote, o turno devolve `mensagens: []` (o n8n não envia), não grava a resposta no Redis e guarda o texto em
  `turno:pendente:<agent>:<fone>`; o turno seguinte junta e responde tudo. Não descarta com transferência,
  ferramenta com efeito (agendar, `enviar_*`, encerrar), sem lock da fila ou depois de 2 descartes seguidos.
  Decisão em `interaction_logs.payload.logs.turno.rajada` e no log `[Rajada]`. `RAJADA_MODE=log` só decide e
  loga; `off` desliga (env no Railway, sem mexer no código).
- **Mídia no fluxo** (`src/agents/midia-no-fluxo.ts`, 05/10/2026): com `prompt_config.midia_no_fluxo: true`, o
  `enviar_arquivo` não manda na hora (mandava dentro do `/api/chat`, então a foto chegava antes do texto do turno).
  A foto volta em `mensagens` como `[[midia:<url>]]` **antes da última mensagem**, o n8n manda em ordem e o
  `/api/send-external` converte o marcador em mídia (com 1,5 s de pausa depois). No Redis o marcador vira
  `[Imagem]`. Sem a chave, nada muda. Primeiro agente: Canda (Costa & Muniz).
- **Estilo no código** (`src/agents/estilo-deterministico.ts`, 23/10/2026): `prompt_config.estilo:
  { "emoji": false, "dividir": true }` é aplicado no texto final, depois dos guards e da mídia e antes do Redis
  (o histórico fica igual ao que o cliente recebe). `emoji: false` tira emoji e arruma o espaço (mensagem só de
  emoji some; se todas sumirem, vão as originais); `dividir: true` = parágrafo vira balão, teto de 4 por turno;
  `dividir: false` = junta o texto seguido numa mensagem; com a chave presente (qualquer valor), `**negrito**`
  vira `*negrito*`. `[[midia:...]]` e URLs não são tocados e a ordem mídia/texto é mantida. **Sem a chave, nada
  muda.** O corpo do `/api/chat` aceita `estilo` (só a suíte manda). Log: `[Estilo]` e
  `interaction_logs.payload.logs.turno.estilo` (`emojisRemovidos`, `baloesAntes/Depois`, `negritoConvertido`).
  Cache da chave: 60 s. Não cobre a mensagem de `makeFallback` (erro interno).
- **Robô do outro lado** (`src/agents/loop-robo.ts`, 23/10/2026): no começo do turno, antes de qualquer LLM, lê as
  mensagens de texto do cliente da última hora; 10+ com até 2 textos diferentes, ou 20+ com 1 diferente para cada 8,
  é resposta automática em loop (Carol 08/10: 764 turnos, US$ 10,98). Pausa: `mensagens: []`, nada no Redis, log
  `[LoopRobo]` e `guard_shadow_logs.verdict = loop_robo_pausado`. Volta sozinho quando a repetição sai da janela.
  Áudio/foto/figurinha (texto vazio) e texto de 1 caractere não contam. Simulado em 30 dias: só os 2 loops da Carol.
  `LOOP_ROBO_MODE=log|off` no Railway desliga sem deploy.
- **Montador em sombra** (`src/agents/montador/`, 23/10/2026): reproduz em código o nó `Prompt_Variavel` do n8n a partir do banco
  (`montar-prompt.ts` função pura; `texto-fixo.ts` = texto da expressão de 23/10 copiado byte a byte; `carregar-entrada.ts` = as mesmas
  consultas do n8n; `sombra.ts` = comparador), compara com o `system_prompt` que o n8n manda no `/api/chat` e registra a diferença.
  **Não substitui o n8n**: o prompt que vale segue sendo o dele, a resposta não muda. Liga por agente com `prompt_config.montador_sombra = true`
  (cache de 60 s), ou para todos com `MONTADOR_SOMBRA=on` no Railway; `MONTADOR_SOMBRA=off` desliga tudo. Agente sem a
  chave custa uma leitura em cache por minuto, nada mais. A leitura do banco começa no início do turno (o `crm_stage` é valor atual e o turno o muda) e a
  montagem, a comparação e a gravação só depois de `res.json`, sem `await`, com try/catch total. Log `[MontadorSombra]` e uma linha por turno em
  `guard_shadow_logs` (a tabela não tem coluna de detalhes): `verdict` = `montador_igual`, `montador_igual_sem_horario` (só o minuto do
  horário) ou `montador_diferente`; `guard_mode = 'montador_sombra'`; comparação em JSON (posição e trechos de 120 caracteres, dados de
  cliente mascarados) em `tokens[1]`, lida com `(tokens[1])::jsonb ->> 'primeiraDiferenca'`. Diferente do guard, grava turno limpo também
  (retenção de 14 dias). Se o texto do n8n mudar, a sombra acusa `montador_diferente` até regenerar `texto-fixo.ts`.
  Medido em 23/10/2026: 226/226 iguais byte a byte (Duda, Leandro, Carol; Dani 1/1) com os dados que o n8n leu; 28/28 relendo do banco com
  as consultas equivalentes (sem o `crm_stage`, que muda depois do turno). Ainda não rodou em produção.
- Mudou algo aqui: testes (`npm test`), push, `/api/version`, e suíte da Duda antes e depois. A suíte é paga
  (~US$ 0,08 por conversa-repetição): pergunte ao dono com o valor.

## Gotchas

- **Redis aqui é memória do agente** (histórico por `agent_id:contact_phone`, TTL 30 dias). No N8N, Redis é debounce.
- `GUARD_MODE` padrão `shadow`. Nunca ligar `enforce` sem os 7 dias de shadow calibrados (SPEC-02 §7).
- O `CONTEXT.md` descreve entrada e saída pelo Chatwoot; no código o Chatwoot só aparece como "era Chatwoot,
  apagado do repo" (`src/tools/handlers.ts:128`). Os trechos de Chatwoot do `CONTEXT.md` estão velhos.

## Registro (nada foi apagado)

- `fast-agent-prompt-SKILL-novo.md` na raiz: rascunho da skill `fast-agent-prompt` (22/08/2026). Está
  **rastreado no git**. Destino não decidido.
- 17 branches locais já mescladas em `master` (18 contando a própria `master`): `feat/kb-corte-por-agente`,
  `spec-02/envelope-e-guard-grounding` e 15 `fix/*`. Podem ser apagadas.
- `spec-01/custo-correto` **não mesclada**: 3 commits à frente de `master` (último 22/08/2026), **sem branch
  no remote**. Só existe nesta máquina.
- `feat/fallback-credito` (`36517ab`, só local): quando a OpenAI devolve erro de crédito/quota, refaz o turno na
  Anthropic com as mesmas ferramentas e registra em `agent_error_logs`. Testado (267/267 com o `master` de
  30/09), **não mesclado**: falta uma `ANTHROPIC_API_KEY` válida. `FALLBACK_CREDITO=off` desliga sem redeploy.
