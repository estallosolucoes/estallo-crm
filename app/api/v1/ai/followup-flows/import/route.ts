import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/import — importa um pacote JSON de automação (manager+, Fase 7).
 *
 * `modo: "previa"` lê e valida o arquivo SEM escrever nada e devolve as referências a remapear com os candidatos
 * desta organização. `modo: "criar"` exige um destino para cada referência (do mesmo tipo, deste tenant), gera ids de
 * bloco novos e grava UM rascunho numa única inserção — falha não deixa nada pela metade. Nunca publica, dispara,
 * cria canal ou instala dependência. Só arquivo: não há importação por URL.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { nomeDaCopia } from "@/lib/followup/nome-da-copia";
import { importarPacote, lerPacote, TETO_DO_PACOTE_BYTES } from "@/lib/followup/pacote";
import { candidatosDaOrganizacao, problemaDoMapa } from "@/lib/followup/referencias-do-pacote";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  modo: z.enum(["previa", "criar"]),
  arquivo: z.string().min(1).max(TETO_DO_PACOTE_BYTES),
  mapa: z.record(z.string(), z.string().uuid()).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  const lido = lerPacote(body.data.arquivo);
  if (!lido.ok) return fail("validation_failed", lido.motivo, 422, { requestId });
  const { pacote } = lido;

  const admin = createAdminClient();
  const destino = await candidatosDaOrganizacao(admin, orgId);

  if (body.data.modo === "previa") {
    return ok(
      {
        nome: pacote.fluxo.nome,
        superficie: pacote.fluxo.superficie,
        origem: pacote.origem,
        blocos: Array.isArray((pacote.grafo as { nodes?: unknown[] }).nodes)
          ? (pacote.grafo as { nodes: unknown[] }).nodes.length
          : 0,
        dependencias: pacote.dependencias,
        candidatos: destino,
      },
      { requestId },
    );
  }

  const mapa = body.data.mapa ?? {};
  const problema = problemaDoMapa(pacote.dependencias, mapa, destino);
  if (problema) return fail("validation_failed", problema, 422, { requestId });

  const importado = importarPacote(pacote, mapa, () => randomUUID());
  if (!importado.ok) return fail("validation_failed", importado.motivo, 422, { requestId });

  const supabase = await createClient();
  const { data: nomes, error: nomesErr } = await supabase
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", orgId);
  if (nomesErr) return fail("internal_error", nomesErr.message, 500, { requestId });
  const existentes = (nomes ?? []).map((r) => String((r as { name: string }).name));
  const nome = existentes.includes(importado.nome) ? nomeDaCopia(importado.nome, existentes) : importado.nome;

  const { data: criado, error: insErr } = await supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: orgId,
      name: nome,
      status: "draft",
      draft_graph: importado.grafo,
      trigger_config: importado.trigger_config,
      handoff_policy: importado.handoff_policy,
      surface: importado.superficie,
    })
    .select("id, name")
    .single();
  if (insErr || !criado) {
    if (insErr?.code === "23505") return fail("conflict", t("Já existe um fluxo com este nome."), 409, { requestId });
    return fail("internal_error", insErr?.message ?? "followup_flow_import_failed", 500, { requestId });
  }

  void audit({
    action: "followup_flow.imported",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId,
    metadata: { name: nome, origem: pacote.origem, dependencias: pacote.dependencias.length },
  });

  return ok(criado, { requestId, status: 201 });
}
