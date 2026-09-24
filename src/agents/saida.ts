// Parse da saída do Orquestrador.
//
// Mora em módulo próprio, e não no orchestrator, pelo mesmo motivo de
// `saudacao.ts`: o orchestrator importa `config`, que exige as env vars do
// servidor. Função pura tem que ser testável sem ambiente completo.
//
// Toda saída que cai no fim desta função vira "instabilidade" + transferência
// para humano. Em 20 dias (05–24/09/2026) foram 4 casos na Duda, e nenhum era
// falha de verdade — o log do Railway mostra a saída crua de cada um:
//
// - 3 vezes o modelo fechou mal o array depois da primeira mensagem
//   (`{"mensagens":["Entendi 😊 ...","redirect_human\": false, ...}`). O texto
//   estava pronto e era bom; se perdia porque o resgate exigia o `]`.
// - 1 vez o modelo devolveu `{"mensagens":[""]}` logo depois de uma intent de
//   texto fixo, que já tinha entregue o texto (com o preço) ao cliente. Não havia
//   nada a acrescentar, e o vazio virou transferência.

import type { ToolCallLog } from '../types';

export type ParsedOutput = { mensagens: string[]; redirect_human: boolean; transfer_reason?: string };

export const MENSAGEM_INSTABILIDADE =
  'Desculpe, estou com uma instabilidade no momento. Pode tentar novamente em instantes? 🙏';

// Uma string do array `mensagens` que ainda tem cara de JSON é JSON duplo-codificado:
// o parse externo teve sucesso e o objeto interno ia limpo para o cliente. Foi o
// vazamento de 08 e 10/08/2026 ("(*mensagens*:[*Perfeito, ...").
export function pareceJson(s: string): boolean {
  const t = s.trim();
  return (
    /"(mensagens|mensagem|redirect_human|transfer_reason)"\s*:/.test(t) ||
    (t.startsWith('{') && t.endsWith('}') && /"[^"]+"\s*:/.test(t))
  );
}

// Um campo do contrato que foi parar dentro do array como texto, com as aspas
// escapadas: `"redirect_human\": false, ...`. Não pode ir para o cliente.
function eCampoVazado(s: string): boolean {
  return /^\s*\\?"?(mensagens|mensagem|redirect_human|transfer_reason)\\?"?\s*:/.test(s);
}

function extrairReason(raw: string): string | undefined {
  const m = raw.match(/"transfer_reason\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*)"/);
  return m?.[1]?.trim() || undefined;
}

// Decodifica o conteúdo de uma string JSON (`\n`, `\"`, `é`). Se o escape
// estiver quebrado, cai no mínimo que já se fazia antes.
function decodificar(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

/**
 * Houve, neste turno, uma ferramenta que já mandou conteúdo direto ao cliente?
 *
 * As intents de texto fixo (`enviar_detalhes_*` e afins) e o `enviar_arquivo`
 * entregam a mensagem sem passar pelo Orquestrador. Depois delas, o Orquestrador
 * não ter mais nada a dizer é resposta legítima, não defeito.
 */
export function entregouAoCliente(tools: ToolCallLog[]): boolean {
  return tools.some((t) => {
    if (!/^enviar_/.test(t.tool)) return false;
    const status = (t.result as { status?: unknown } | null)?.status;
    return status === 'ok';
  });
}

// `vazio: true` = o JSON era válido, mas nenhuma mensagem tinha texto.
function normalizeparsed(
  parsed: Record<string, unknown>,
): ParsedOutput | { vazio: true; redirect_human: boolean; transfer_reason?: string } | null {
  const redirect = Boolean(parsed.redirect_human ?? false);
  const reason   = redirect && typeof parsed.transfer_reason === 'string' && parsed.transfer_reason.trim()
    ? parsed.transfer_reason.trim()
    : undefined;

  // { mensagens: string[] }
  if (Array.isArray(parsed.mensagens)) {
    const mensagens = parsed.mensagens.map(String).filter((m) => m.trim() !== '' && !pareceJson(m));
    if (mensagens.length > 0) return { mensagens, redirect_human: redirect, transfer_reason: reason };
    // Array só com strings vazias: é vazio de verdade. Array cujo conteúdo foi
    // filtrado por parecer JSON não é — esse segue para o resgate e o fallback.
    const soVazias = parsed.mensagens.every((m) => String(m).trim() === '');
    return soVazias ? { vazio: true, redirect_human: redirect, transfer_reason: reason } : null;
  }

  // { mensagens: string }
  if (typeof parsed.mensagens === 'string' && parsed.mensagens.trim()) {
    return { mensagens: [parsed.mensagens.trim()], redirect_human: redirect, transfer_reason: reason };
  }

  // { mensagem: string }
  if (typeof parsed.mensagem === 'string' && parsed.mensagem.trim()) {
    return { mensagens: [parsed.mensagem.trim()], redirect_human: redirect, transfer_reason: reason };
  }

  return null;
}

function tentarJson(raw: string) {
  try {
    return normalizeparsed(JSON.parse(raw));
  } catch {}
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return normalizeparsed(JSON.parse(match[0]));
  } catch {}
  return null;
}

/**
 * @param raw               texto cru devolvido pelo modelo
 * @param entregouConteudo  `entregouAoCliente(tools do turno)`: se já saiu texto
 *                          fixo ou arquivo, resposta vazia vira silêncio, não erro
 */
export function parseOrchestratorOutput(raw: string, entregouConteudo = false): ParsedOutput {
  const json = tentarJson(raw);
  if (json && !('vazio' in json)) return json;

  if (json && 'vazio' in json) {
    // Transferência pedida sem texto: o cliente precisa de uma linha antes do humano.
    if (json.redirect_human) {
      return { mensagens: [MENSAGEM_INSTABILIDADE], redirect_human: true, transfer_reason: json.transfer_reason ?? 'Resposta vazia do modelo' };
    }
    if (entregouConteudo) return { mensagens: [], redirect_human: false };
    console.error('[Orchestrator] Resposta vazia sem texto fixo no turno:', raw.slice(0, 300));
    return { mensagens: [MENSAGEM_INSTABILIDADE], redirect_human: true, transfer_reason: 'Resposta vazia do modelo' };
  }

  // JSON malformado: resgata os textos do array "mensagens" antes de desistir.
  // O `]` de fechamento é opcional — o modelo às vezes enfia o resto do objeto
  // dentro do array como texto e nunca fecha.
  const bloco = raw.match(/"mensagens"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
  if (bloco) {
    const textos = [...bloco[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .filter((t) => !eCampoVazado(t))
      .map((t) => decodificar(t).trim())
      .filter((t) => t !== '' && !pareceJson(t));
    if (textos.length) {
      // `transfer_reason` caía no chão aqui: o pedido de humano chegava sem motivo.
      const red = /"redirect_human\\?"\s*:\s*true/.test(raw);
      return {
        mensagens: textos,
        redirect_human: red,
        transfer_reason: red ? extrairReason(raw) : undefined,
      };
    }
  }

  const text = raw.trim();

  // Se ainda parece JSON, não pode ir para o cliente. Um texto legítimo pode
  // começar com "{" ou "[" (ex.: "[IMPORTANTE] chegue 15 min antes"), então só
  // barra o que tem cara de objeto de saída: campo conhecido, ou objeto fechado
  // com par "chave": valor.
  const temCampoConhecido = /"(mensagens|mensagem|redirect_human|transfer_reason)"\s*:/.test(text);
  const objetoFechado = text.startsWith('{') && text.endsWith('}') && /"[^"]+"\s*:/.test(text);
  if (!text || temCampoConhecido || objetoFechado) {
    console.error('[Orchestrator] Saída não parseável:', text.slice(0, 500));
    // Saída ilegível é falha nossa, não "está tudo bem". Antes devolvia
    // redirect_human:false hardcoded e um pedido genuíno de humano sumia.
    return {
      mensagens: [MENSAGEM_INSTABILIDADE],
      redirect_human: true,
      transfer_reason: extrairReason(raw) ?? 'Saída do modelo não parseável',
    };
  }

  return {
    mensagens: [text],
    redirect_human: false,
  };
}
