import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/step (manager+) — conduz uma execução PASSO A PASSO.
 *
 *   { "acao": "proximo" }   → «Executar próximo bloco»: o motor roda o bloco em que a execução está pausada e pausa de
 *                             novo no seguinte (leva até o próximo ciclo do motor, cerca de um minuto);
 *   { "acao": "continuar" } → «Continuar automaticamente»: tira a marca e a execução segue sozinha dali em diante.
 *
 * Só vale para execução com a marca `passo_a_passo` pausada por pessoa. O UPDATE é guardado pelo estado lido e pelo
 * lease do motor, então clique duplo ou motor ocupado devolvem 409 em vez de rodar dois blocos.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { continuaAutomaticamente, executaProximoBloco } from "@/lib/followup/intervencao";
import { respostaDaFalha } from "@/lib/followup/intervencao-resposta";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

const corpoSchema = z.object({ acao: z.enum(["proximo", "continuar"]) }).strict();

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const invalido = validaIdDaRota(id, requestId);
  if (invalido) return invalido;

  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  }

  const deps = {
    supabase: await createClient(),
    admin: createAdminClient(),
    orgId: org.orgId,
    userId: user.id,
    requestId,
  };
  const resultado =
    parsed.data.acao === "proximo" ? await executaProximoBloco(deps, id) : await continuaAutomaticamente(deps, id);
  if (!resultado.ok) return respostaDaFalha(resultado, requestId, t);

  void audit({
    action: parsed.data.acao === "proximo" ? "followup_enrollment.step_executed" : "followup_enrollment.auto_continued",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { node_id: resultado.enrollment.current_node_id },
  });

  return ok({ id, status: resultado.status_novo, next_eval_at: resultado.next_eval_at }, { requestId });
}
