/**
 * PATCH  /api/v1/custom-fields/[id] — edita uma definição (admin).
 * DELETE /api/v1/custom-fields/[id] — apaga a definição (admin). Os valores já
 *        gravados em `custom_fields` ficam (apagar dado do cliente é outra
 *        decisão); para só esconder, use `hidden`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DA_DEFINICAO, edicaoDeCampoSchema } from "@/lib/campos/definicao";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "custom_field_definitions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = edicaoDeCampoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t(parsed.error.issues[0]?.message ?? "Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const pedido = parsed.data;
  if (pedido.type && ["select", "multiselect"].includes(pedido.type) && pedido.options?.length === 0) {
    return fail("validation_failed", t("Lista de opções precisa de pelo menos uma opção."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("custom_field_definitions")
    .update(pedido)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_DEFINICAO)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Campo não encontrado."), 404, { requestId });

  void audit({
    action: "custom_field.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "custom_field_definition",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(pedido) },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "custom_field_definitions" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("custom_field_definitions")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id, entity, key")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) {
    return fail("not_found", traduzir("Campo não encontrado.", authz.user.idioma), 404, { requestId });
  }

  void audit({
    action: "custom_field.deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "custom_field_definition",
    resourceId: id,
    requestId,
    metadata: { entity: data.entity, key: data.key },
  });
  return ok({ id }, { requestId });
}
