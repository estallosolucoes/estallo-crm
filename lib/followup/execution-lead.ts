import type { SupabaseClient } from "@supabase/supabase-js";

/** Ausente = contrato legado. null explícito = execução sem lead, nunca "o mais recente". */
export interface ExecutionLeadTarget {
  execution_contract: 1;
  lead_id: string | null;
}

export function executionLeadTarget(enrollment: {
  execution_contract?: 0 | 1;
  lead_id?: string | null;
}): ExecutionLeadTarget | undefined {
  return enrollment.execution_contract === 1
    ? { execution_contract: 1, lead_id: enrollment.lead_id ?? null }
    : undefined;
}

export class ExecutionLeadUnavailableError extends Error {
  readonly code = "execution_lead_unavailable";

  constructor() {
    super("execution_lead_unavailable");
    this.name = "ExecutionLeadUnavailableError";
  }
}

/**
 * Seleção compartilhada por fatos, render e escritores do motor existente.
 * O contrato novo exige o alvo fixado e revalida organização/contato. O filtro
 * de funil e a ordenação preservam exclusivamente o comportamento legado.
 */
export async function loadLeadForExecution<T extends Record<string, unknown>>(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  columns: string,
  target?: ExecutionLeadTarget,
  legacyPipelineId?: string,
): Promise<T | null> {
  if (target?.lead_id === null) return null;

  let query = admin
    .from("crm_leads")
    .select(columns)
    .eq("organization_id", orgId)
    .eq("contact_id", contactId);

  if (target) {
    query = query.eq("id", target.lead_id);
  } else {
    if (legacyPipelineId) query = query.eq("pipeline_id", legacyPipelineId);
    query = query.order("updated_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data && target) throw new ExecutionLeadUnavailableError();
  return data as unknown as T | null;
}
