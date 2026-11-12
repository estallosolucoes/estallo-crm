/**
 * GET  /api/v1/custom-fields?entity=lead|contact — o cadastro central de campos
 *      personalizados da empresa (viewer+), com os funis e etapas para a tela.
 * POST /api/v1/custom-fields — cria uma definição (admin).
 *
 * A projeção dos campos de LEAD em `crm_pipelines.settings.fields` é do banco
 * (trigger da migration 0657), então criar aqui já vale no dossiê, na validação
 * de obrigatórios e no follow-up.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  chaveDoRotulo,
  COLUNAS_DA_DEFINICAO,
  definicaoDeCampoSchema,
  ENTIDADES_DE_CAMPO,
} from "@/lib/campos/definicao";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "custom_field_definitions" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const entity = req.nextUrl.searchParams.get("entity");
  if (entity && !(ENTIDADES_DE_CAMPO as readonly string[]).includes(entity)) {
    return fail("invalid_request", traduzir("Filtro inválido.", authz.user.idioma), 400, { requestId });
  }

  const supabase = await createClient();
  let q = supabase
    .from("custom_field_definitions")
    .select(COLUNAS_DA_DEFINICAO)
    .eq("organization_id", orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (entity) q = q.eq("entity", entity);
  const [definicoes, funis, etapas] = await Promise.all([
    q,
    supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    supabase
      .from("crm_stages")
      .select("id, pipeline_id, name, is_won, is_lost")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
  ]);
  const erro = definicoes.error ?? funis.error ?? etapas.error;
  if (erro) return fail("internal_error", erro.message, 500, { requestId });

  return ok(
    {
      definicoes: definicoes.data ?? [],
      funis: (funis.data ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        etapas: (etapas.data ?? [])
          .filter((e) => e.pipeline_id === f.id)
          .map((e) => ({ id: e.id, name: e.name, is_won: e.is_won, is_lost: e.is_lost })),
      })),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "custom_field_definitions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = definicaoDeCampoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t(parsed.error.issues[0]?.message ?? "Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const supabase = await createClient();
  const { data: existentes, error: lerErr } = await supabase
    .from("custom_field_definitions")
    .select("key, position")
    .eq("organization_id", orgId)
    .eq("entity", input.entity);
  if (lerErr) return fail("internal_error", lerErr.message, 500, { requestId });
  const ocupadas = new Set((existentes ?? []).map((d) => d.key as string));
  if (input.key && ocupadas.has(input.key)) {
    return fail("conflict", t("Já existe um campo com essa chave."), 409, { requestId });
  }
  const key = input.key ?? chaveDoRotulo(input.label, ocupadas);
  // Campo novo entra no FIM da lista.
  const position =
    input.position ?? Math.max(0, ...(existentes ?? []).map((d) => Number(d.position) || 0)) + 1000;

  const { data, error } = await supabase
    .from("custom_field_definitions")
    .insert({ ...input, key, position, organization_id: orgId })
    .select(COLUNAS_DA_DEFINICAO)
    .single();
  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um campo com essa chave."), 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "custom_field.created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "custom_field_definition",
    resourceId: data.id,
    requestId,
    metadata: { entity: input.entity, key, type: input.type },
  });
  return ok(data, { status: 201, requestId });
}
