import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  EXECUTION_RETENTION_LIMITS,
  executionRetentionUpdateSchema,
  readExecutionRetention,
} from "@/lib/followup/execution-retention";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const db = await createClient();
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error)
    return fail("internal_error", t("Não foi possível carregar a retenção do histórico."), 500, {
      requestId,
    });
  if (!data) return fail("not_found", t("Organização não encontrada."), 404, { requestId });
  const settings = data.settings as { automations?: { retention?: unknown } } | null;
  return ok(
    {
      ...readExecutionRetention(settings?.automations?.retention),
      limits: EXECUTION_RETENTION_LIMITS,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const parsed = executionRetentionUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira os prazos de retenção.", 422, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const db = createAdminClient();
  // O RPC bloqueia a organização e altera só automations.retention; não há
  // leitura seguida de sobrescrita de settings no client, nem org vinda do body.
  const { data, error } = await db.rpc(
    "fn_set_followup_retention_policy" as never,
    {
      p_org: authz.org.orgId,
      p_policy: parsed.data,
    } as never,
  );
  if (error)
    return fail("internal_error", t("Não foi possível salvar a retenção do histórico."), 500, {
      requestId,
    });
  if (data !== true) return fail("not_found", t("Organização não encontrada."), 404, { requestId });
  void audit({
    action: "followup.retention_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    bypassedRls: true,
    metadata: parsed.data,
  });
  return ok(
    { policy: parsed.data, configuration_valid: true, limits: EXECUTION_RETENTION_LIMITS },
    { requestId },
  );
}
