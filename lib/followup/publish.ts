/**
 * Publish wrapper around the SQL function fn_publish_followup_flow_version
 * (migration 0056). Mirrors lib/ai/agents/publish.ts — insert version +
 * activate pointer happen atomically inside the SECURITY DEFINER function,
 * called via the admin client since EXECUTE is revoked from authenticated.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph } from "./graph-schema";

/**
 * Motor único: todo fluxo do relógio (follow-up e automação do CRM) é publicado no contrato de
 * execução 1. O roteiro de atendimento não: ele roda no turno, não pelo diário. A chave entra aqui,
 * antes da validação, para o publicador validar o que de fato vai valer (blocos não integrados e a
 * saída "Fallback erro" são conferidos como contrato 1).
 */
export function comContratoDeExecucao(graph: FlowGraph, surface: string): FlowGraph {
  return surface === "atendimento" ? graph : { ...graph, execution_contract: 1 };
}

export interface PublishFlowOk {
  ok: true;
  version_id: string;
}

export interface PublishFlowFail {
  ok: false;
  code: "pointer_not_found" | "execution_contract_unavailable" | "internal_error";
  message: string;
}

export type PublishFlowResult = PublishFlowOk | PublishFlowFail;

export async function publishFollowupFlowVersion(
  admin: SupabaseClient,
  params: { orgId: string; pointerId: string; graph: FlowGraph; createdBy: string },
): Promise<PublishFlowResult> {
  const { data, error } = await admin.rpc("fn_publish_followup_flow_version", {
    p_org: params.orgId,
    p_pointer: params.pointerId,
    p_graph: params.graph,
    p_created_by: params.createdBy,
  });

  if (error) {
    const raw = (error.message ?? "").trim();
    if (raw === "pointer_not_found") {
      return { ok: false, code: "pointer_not_found", message: raw };
    }
    // A guarda do banco (migration 0707): o validador da rota já recusa antes, então só chega aqui
    // por um chamador que o contorne. É uma recusa de validação, não uma falha do servidor.
    if (raw === "execution_contract_unavailable") {
      return { ok: false, code: "execution_contract_unavailable", message: raw };
    }
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  if (typeof data !== "string") {
    return { ok: false, code: "internal_error", message: "no_version_id_returned" };
  }
  return { ok: true, version_id: data };
}
