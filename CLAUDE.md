# fast-agent-api

**Doc principal: `CONTEXT.md`** (fluxo, prompt em duas camadas, executor, memória). Ler antes de mexer.

## Cartão

| | |
|---|---|
| Repo | `jguilhermesl/fast-agent-api`, branch `master` |
| Deploy | Railway, `https://fast-agent-api.up.railway.app`. `GET /api/version` devolve o commit no ar: comparar com `git rev-parse master`. Token: `RAILWAY_TOKEN_FAST_AGENT_API` em `C:\Users\Usuario\.claude\.env.local` |
| Mundo | **Fast IA legada** (Chatwoot + Redis + Railway). Hoje também é o backend LLM da Plataforma Agents: o `AGENTE BASE` do n8n chama `/api/chat`, e o `messaging-gateway` do `../chat-flow-pilot-63` chama `/api/add-context` e `/api/send-external` |
| Stack | Node + TypeScript + Express · Redis · Supabase (`agents`, `leads`, `intent_execution_logs`) · OpenAI/Anthropic. Rotas `/api/chat`, `/api/stages`, `/api/send-external`, `/api/add-context`, `/api/typing`, `/api/version` |

## Comandos

```bash
npm run dev | build | start         # tsx watch src/index.ts · tsc · node dist/index.js
npm run lint | typecheck | test     # test = vitest run
npm run test:smoke   # tsx scripts/smoke-http.ts
```

Env obrigatória (só nomes, `src/config/index.ts`): `API_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `WEBHOOK_SECRET`. Opcional: `REDIS_URL`,
`ZAPI_CLIENT_TOKEN`, `GUARD_MODE`, `CRUZAMENTO_MODE`. Qual Supabase está no env do Railway: não verificado.

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
