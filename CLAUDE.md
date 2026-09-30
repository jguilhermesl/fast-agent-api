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
`ZAPI_CLIENT_TOKEN`, `GUARD_MODE`, `CRUZAMENTO_MODE`, `RAJADA_MODE`. Qual Supabase está no env do Railway: não verificado.

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
