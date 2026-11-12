/**
 * GET /api/v1/ai/followup-flows/:id/export?origem=rascunho|publicado — o pacote JSON do fluxo (manager+, Fase 7).
 *
 * Leva grafo, gatilho, política de atendimento e o manifesto das referências externas (tipo e nome na origem).
 * NÃO leva execuções, saídas, amostras nem dado de cliente. Segredo embutido numa configuração faz a exportação
 * RECUSAR (422) com o lugar de cada um: melhor não exportar do que entregar uma chave num arquivo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { montarPacote, segredosEmbutidos, uuidsCitados } from "@/lib/followup/pacote";
import { candidatosDaOrganizacao, classificarReferencias } from "@/lib/followup/referencias-do-pacote";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const origemPedida = req.nextUrl.searchParams.get("origem") === "publicado" ? "versao" : "rascunho";

  const supabase = await createClient();
  const { data: fluxo, error } = await supabase
    .from("followup_flow_pointers")
    .select("id, name, draft_graph, trigger_config, handoff_policy, surface, active_version_id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!fluxo) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  let grafoBruto: unknown = fluxo.draft_graph;
  let versaoNumero: number | null = null;
  if (origemPedida === "versao") {
    if (!fluxo.active_version_id)
      return fail("validation_failed", t("Este fluxo ainda não tem versão publicada."), 422, { requestId });
    const { data: versoes, error: vErr } = await supabase
      .from("followup_flow_versions")
      .select("id, graph, created_at")
      .eq("organization_id", orgId)
      .eq("pointer_id", id)
      .order("created_at", { ascending: true });
    if (vErr) return fail("internal_error", vErr.message, 500, { requestId });
    const i = (versoes ?? []).findIndex((v) => v.id === fluxo.active_version_id);
    if (i < 0) return fail("not_found", t("Versão não encontrada."), 404, { requestId });
    grafoBruto = versoes![i]!.graph;
    versaoNumero = i + 1;
  }
  const grafo = flowGraphSchema.safeParse(grafoBruto);
  if (!grafo.success) return fail("validation_failed", t("O fluxo está vazio ou inválido para exportar."), 422, { requestId });

  const configuracoes = [grafo.data.nodes.map((n) => n.config), fluxo.trigger_config];
  const segredos = segredosEmbutidos(configuracoes);
  if (segredos.length > 0)
    return fail(
      "validation_failed",
      t("O fluxo tem segredo escrito numa configuração. Troque por uma conexão protegida antes de exportar."),
      422,
      { requestId, details: { segredos } },
    );

  const admin = createAdminClient();
  const dependencias = classificarReferencias(uuidsCitados(configuracoes), await candidatosDaOrganizacao(admin, orgId));
  const pacote = montarPacote({
    nome: String(fluxo.name),
    superficie: (fluxo.surface ?? "followup") as "followup",
    handoff_policy: fluxo.handoff_policy as "pause",
    trigger_config: fluxo.trigger_config,
    grafo: grafo.data,
    origem: { tipo: origemPedida, versao_numero: versaoNumero, exportado_em: new Date().toISOString() },
    dependencias,
  });

  void audit({
    action: "followup_flow.exported",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { origem: origemPedida, versao_numero: versaoNumero, dependencias: dependencias.length },
  });

  return ok(pacote, { requestId });
}
