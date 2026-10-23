// Montador único em SOMBRA: monta o prompt a partir do banco, compara com o `system_prompt` que o n8n
// mandou e registra a diferença. NÃO muda a resposta: o prompt que vale continua sendo o do n8n.
//
// Liga com `MONTADOR_SOMBRA=on` (env no Railway). Sem isso nada roda e nenhuma consulta extra é feita.
//
// Uso em routes/chat.ts:
//   const concluirSombra = iniciarSombraMontador(data);   // logo que o pedido é validado
//   ...turno...
//   res.json(response);
//   concluirSombra?.();                                   // depois que a resposta saiu
//
// `iniciar` só dispara a leitura do banco (sem esperar). `concluir` monta, compara e grava sem bloquear
// ninguém e sem nunca lançar erro. A leitura começa no início do turno porque o `crm_stage` é a leitura
// atual do lead e o próprio turno pode mudá-lo; o que o turno grava depois (intenções, mensagens) fica de
// fora pelo corte de data em `carregarEntrada`.

import { carregarEntrada, type ParamsCarga } from './carregar-entrada';
import { montarPrompt, type EntradaMontador } from './montar-prompt';
import { compararComN8n, vereditoDe, type ComparacaoMontador, type VereditoMontador } from './sombra';
import { logGuardShadow } from '../../services/supabase';

export interface TurnoParaSombra {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  contact_phone: string;
  /** O `system_prompt` que o n8n mandou no corpo do /api/chat. */
  system_prompt: string;
}

export interface RegistroSombra {
  agent_id: string;
  conversation_id: string;
  lead_id: string;
  verdict: VereditoMontador;
  comparacao: ComparacaoMontador;
}

export interface DepsSombra {
  carregar: (p: ParamsCarga) => Promise<EntradaMontador>;
  registrar: (r: RegistroSombra) => Promise<void>;
}

/** Fica em `guard_shadow_logs.guard_mode` para separar estas linhas das do guard de grounding. */
export const MODO_MONTADOR_SOMBRA = 'montador_sombra';

export function sombraDoMontadorLigada(): boolean {
  return process.env.MONTADOR_SOMBRA === 'on';
}

/**
 * `guard_shadow_logs` não tem coluna de detalhes: a comparação inteira (sem o prompt) vai como JSON no
 * único item de `tokens`. Ler no SQL: `(tokens[1])::jsonb ->> 'primeiraDiferenca'`.
 */
export async function registrarEmGuardShadowLogs(r: RegistroSombra): Promise<void> {
  await logGuardShadow({
    agent_id: r.agent_id,
    conversation_id: r.conversation_id,
    lead_id: r.lead_id,
    verdict: r.verdict,
    tokens: [JSON.stringify(r.comparacao)],
    mensagens: [],
    tools_called: [],
    guard_mode: MODO_MONTADOR_SOMBRA,
  });
}

const DEPS_PADRAO: DepsSombra = { carregar: (p) => carregarEntrada(p), registrar: registrarEmGuardShadowLogs };

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Dispara a leitura do banco e devolve a função que fecha a comparação, ou `null` com a sombra desligada.
 * Nunca lança.
 */
export function iniciarSombraMontador(turno: TurnoParaSombra, deps: DepsSombra = DEPS_PADRAO): (() => void) | null {
  if (!sombraDoMontadorLigada()) return null;
  try {
    const recebido = turno.system_prompt;
    const carga = deps
      .carregar({
        agentId: turno.agent_id,
        conversationId: turno.conversation_id,
        leadId: turno.lead_id,
        contatoTelefone: turno.contact_phone,
        recebidoEm: new Date(),
      })
      .then(
        (entrada): EntradaMontador | null => entrada,
        (err: unknown) => {
          console.error('[MontadorSombra] entrada não carregada, turno fora da medição:', mensagemDe(err));
          return null;
        },
      );

    return () => {
      void concluir(turno, recebido, carga, deps);
    };
  } catch (err) {
    console.error('[MontadorSombra] não iniciou:', mensagemDe(err));
    return null;
  }
}

async function concluir(
  turno: TurnoParaSombra,
  recebido: string,
  carga: Promise<EntradaMontador | null>,
  deps: DepsSombra,
): Promise<void> {
  try {
    const entrada = await carga;
    if (!entrada) return;

    const montado = montarPrompt(entrada);
    const comparacao = compararComN8n(montado, recebido);
    const verdict = vereditoDe(comparacao);

    console.log(
      '[MontadorSombra]',
      JSON.stringify({
        agent_id: turno.agent_id,
        conversation_id: turno.conversation_id,
        verdict,
        tamanhoMontado: comparacao.tamanhoMontado,
        tamanhoRecebido: comparacao.tamanhoRecebido,
        primeiraDiferenca: comparacao.primeiraDiferenca,
      }),
    );

    await deps.registrar({
      agent_id: turno.agent_id,
      conversation_id: turno.conversation_id,
      lead_id: turno.lead_id,
      verdict,
      comparacao,
    });
  } catch (err) {
    console.error('[MontadorSombra] falhou, ignorado:', mensagemDe(err));
  }
}
