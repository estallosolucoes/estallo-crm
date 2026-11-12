import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/ai/followup-http-connections/:id — apaga a conexão (admin). Fluxo que a citava passa a falhar com
 * "a conexão não existe mais" (publicação e execução), nunca chama outro lugar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "automation_http_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  const { data: removida, error } = await createAdminClient()
    .from("automation_http_connections")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, label")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao remover a conexão.", 500, { requestId });
  if (!removida) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
  await audit({
    action: "automation_http_connection.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "automation_http_connection",
    resourceId: id,
    requestId,
    metadata: { label: removida.label },
  });
  return ok({ id, deleted: true }, { requestId });
}
