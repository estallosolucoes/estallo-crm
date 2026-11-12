import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/leads/[id]/produtos/[itemId] — quantidade e desconto do item.
 * DELETE /api/v1/leads/[id]/produtos/[itemId] — tira o produto do negócio.
 *
 * Estallo (0660). O valor do negócio se recalcula pela trigger.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  COLUNAS_DO_PRODUTO_DO_NEGOCIO,
  produtoDoNegocioUpdateSchema,
} from "@/lib/schemas/produtos-do-negocio";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; itemId: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId, itemId } = await ctx.params;

  const parsed = produtoDoNegocioUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_lead_products")
    .update(parsed.data)
    .eq("id", itemId)
    .eq("lead_id", leadId)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DO_PRODUTO_DO_NEGOCIO)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao alterar o produto do negócio.", 500, { requestId });
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "lead_product.updated",
    resourceType: "crm_lead_products",
    resourceId: itemId,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId, itemId } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_lead_products")
    .delete()
    .eq("id", itemId)
    .eq("lead_id", leadId)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao tirar o produto do negócio.", 500, { requestId });
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "lead_product.removed",
    resourceType: "crm_lead_products",
    resourceId: itemId,
    requestId,
  });

  return ok({ id: itemId }, { requestId });
}
