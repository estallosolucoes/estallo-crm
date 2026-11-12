import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/leads/[id]/produtos — os produtos do negócio.
 * POST /api/v1/leads/[id]/produtos — vincula um produto do catálogo.
 *
 * Estallo (0660). Nome e preço são COPIADOS do catálogo aqui, nunca do corpo; o
 * valor do negócio é recalculado pela trigger `fn_crm_lead_products_recalcula_valor`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  COLUNAS_DO_PRODUTO_DO_NEGOCIO,
  produtoDoNegocioCreateSchema,
} from "@/lib/schemas/produtos-do-negocio";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_lead_products" });
  if (!authz.ok) return authz.response;
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_lead_products")
    .select(COLUNAS_DO_PRODUTO_DO_NEGOCIO)
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar os produtos do negócio.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_lead_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;

  const parsed = produtoDoNegocioCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const orgId = authz.org.orgId;

  // O negócio vem pela RLS de quem chama e é conferido na org da sessão.
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const { data: produto } = await supabase
    .from("catalog_products")
    .select("id, nome, preco_cents")
    .eq("id", parsed.data.product_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!produto) return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  const p = produto as { id: string; nome: string; preco_cents: number };

  const { data, error } = await supabase
    .from("crm_lead_products")
    .insert({
      organization_id: orgId,
      lead_id: leadId,
      product_id: p.id,
      nome: p.nome,
      preco_unitario_cents: p.preco_cents,
      quantidade: parsed.data.quantidade ?? 1,
      desconto_cents: parsed.data.desconto_cents ?? 0,
    })
    .select(COLUNAS_DO_PRODUTO_DO_NEGOCIO)
    .single();
  if (error) return fail("internal_error", "Erro ao vincular o produto.", 500, { requestId });

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "lead_product.added",
    resourceType: "crm_lead_products",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
