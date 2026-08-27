import { Router } from 'express';

export const versionRouter = Router();

/**
 * Diz qual commit está rodando.
 *
 * Sem isto não havia como provar o que estava em produção: o serviço não expunha
 * `/api/version` nem `/health`, então "deployado" era fé. Conferir passa a ser
 * comparar este `commit` com `git rev-parse master`.
 *
 * O Railway injeta `RAILWAY_GIT_COMMIT_SHA` em cada build. Fora dele o valor é
 * "desconhecido" — o endpoint responde do mesmo jeito, só sem SHA.
 */
versionRouter.get('/', (_req, res) => {
  res.json({
    service: 'fast-agent-api',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'desconhecido',
    branch: process.env.RAILWAY_GIT_BRANCH ?? 'desconhecido',
    deployed_at: process.env.RAILWAY_DEPLOYMENT_CREATED_AT ?? null,
    started_at: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    uptime_s: Math.round(process.uptime()),
    node: process.version,
  });
});
