/**
 * Execução PASSO A PASSO (migration 0714): o operador conduz a execução um bloco por vez.
 *
 * Regra única, usada por TODO lugar que faz uma execução mudar de bloco — o motor (`engine.ts`) e a ponte que conclui o
 * envio de um turno (`turn-bridge.ts`): quando a execução é passo a passo e o patch MUDA o bloco atual, o bloco acabou
 * de ser concluído e a execução fica pausada (`paused_manual`, sem horário) no seguinte. O seguinte só roda quando a
 * pessoa mandar («Executar próximo bloco», `executaProximoBloco`).
 *
 * Patch que não muda de bloco (espera de resposta, nova tentativa de envio, recheck) passa como está: o bloco ainda
 * está sendo cumprido, e pausar no meio dele deixaria um envio pela metade.
 */
import type { EnrollmentPatch } from "./engine";

export function pausaDepoisDoBloco(
  enrollment: { passo_a_passo?: boolean; current_node_id: string },
  patch: EnrollmentPatch,
): EnrollmentPatch {
  if (enrollment.passo_a_passo !== true) return patch;
  if (patch.current_node_id === undefined || patch.current_node_id === enrollment.current_node_id) return patch;
  // Execução que termina (cancelada/concluída/morta) não é pausada: o patch já traz o estado final.
  if (patch.status !== undefined && patch.status !== "active") return patch;
  return { ...patch, status: "paused_manual", next_eval_at: null };
}
