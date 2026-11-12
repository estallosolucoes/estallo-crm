import type pg from "pg";

import { ExecutionLeadUnavailableError, type ExecutionLeadTarget } from "./execution-lead";

/** Mesma seleção do adapter REST, usada pelo worker e pelo render de mensagens. */
export async function loadExecutionLeadPg(
  pool: Pick<pg.Pool, "query">,
  organizationId: string,
  contactId: string,
  target?: ExecutionLeadTarget,
): Promise<Record<string, unknown> | null> {
  if (target?.lead_id === null) return null;
  const { rows } = target
    ? await pool.query<Record<string, unknown>>(
        "select * from crm_leads where organization_id = $1 and contact_id = $2 and id = $3",
        [organizationId, contactId, target.lead_id],
      )
    : await pool.query<Record<string, unknown>>(
        "select * from crm_leads where organization_id = $1 and contact_id = $2 order by updated_at desc limit 1",
        [organizationId, contactId],
      );
  if (target && !rows[0]) throw new ExecutionLeadUnavailableError();
  return rows[0] ?? null;
}
