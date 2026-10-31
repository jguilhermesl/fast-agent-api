import { z } from 'zod';

/**
 * `estilo` no corpo do /api/chat (a suíte e a demo repassam o `prompt_config.estilo` do agente).
 * Mesmo contrato de `agents/estilo-deterministico.ts` (`lerEstilo`): `emoji` aceita `"raro"`
 * desde 31/10/2026. Antes o esquema só aceitava booleano, e agente com `emoji: "raro"`
 * levaria 400 na demo e na suíte.
 */
export const esquemaEstilo = z.object({
  emoji: z.union([z.boolean(), z.literal('raro')]).optional(),
  dividir: z.boolean().optional(),
});
