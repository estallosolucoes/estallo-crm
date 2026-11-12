/**
 * GET/PATCH /api/v1/settings/agenda-habilitada — a chave da Agenda da empresa
 * (`organizations.settings.agenda_habilitada`). Desligada, somem a tela, o
 * menu e as ferramentas de agendamento do agente (`lib/organizacao/capacidades.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ habilitada: z.boolean() }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;
  const { data } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .single();
  const settings = (data?.settings as Record<string, unknown> | null) ?? {};
  return ok({ habilitada: settings.agenda_habilitada === true }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  // Mesma leitura-e-mescla de /settings/proposals: só a chave da Agenda muda.
  const supabase = createAdminClient();
  const { data: atual } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .single();
  const settings = (atual?.settings as Record<string, unknown> | null) ?? {};
  const { error } = await supabase
    .from("organizations")
    .update({ settings: { ...settings, agenda_habilitada: parsed.data.habilitada } })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });

  void audit({
    action: "agenda.capacidade_alterada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { habilitada: parsed.data.habilitada },
  });
  return ok(parsed.data, { requestId });
}
