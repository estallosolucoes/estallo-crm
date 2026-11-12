import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/restart (manager+) — reinicia uma execução TERMINADA: cria uma execução
 * nova, independente, desde o gatilho, na mesma versão do fluxo. A original não é alterada.
 *
 * Repete efeitos (mensagens, tarefas, movimentos) por ser execução nova — a tela avisa e pede confirmação antes. O
 * header `Idempotency-Key` é aceito: o mesmo clique repetido devolve a mesma reexecução em vez de criar outra.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { reiniciarExecucao, type ReiniciarResultado } from "@/lib/followup/reiniciar";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { validaIdDaRota } from "../_id";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

/** Corpo opcional: `{ "passo_a_passo": true }` cria a reexecução pausada, para o operador executar um bloco por vez. */
/**
 * `modo: "retry"` (Fase 6) = RECUPERAR a partir da falha: a execução nova começa no bloco que falhou e herda as saídas
 * da original. Sem `modo`, reiniciar desde o gatilho (o de sempre).
 */
const corpoSchema = z.object({ passo_a_passo: z.boolean().optional(), modo: z.enum(["restart", "retry"]).optional() }).strict();

const ENDPOINT = "POST /api/v1/ai/followups/enrollments/:id/restart";

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

  let bruto: unknown = {};
  try {
    const texto = await req.text();
    if (texto.trim() !== "") bruto = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const corpo = corpoSchema.safeParse(bruto);
  if (!corpo.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: corpo.error.flatten() });
  }
  const passoAPasso = corpo.data.passo_a_passo === true;
  const modo = corpo.data.modo ?? "restart";

  const executar = () =>
    reiniciarExecucao(createAdminClient(), {
      organizationId: org.orgId,
      enrollmentId: id,
      actorUserId: user.id,
      requestId,
      passoAPasso,
      modo,
    });
  const recusar = (r: Extract<ReiniciarResultado, { ok: false }>) =>
    fail(r.code, r.code === "internal_error" ? r.message : t(r.message), r.status, { requestId });

  const chave = chaveDaRequisicao(req);
  if (chave === null) {
    const r = await executar();
    return r.ok ? ok(r.enrollment, { requestId, status: 201 }) : recusar(r);
  }

  // Com chave: só o resultado de SUCESSO vira recibo (uma recusa não deve ser repetida como se fosse a resposta).
  const estado: { recusado: Extract<ReiniciarResultado, { ok: false }> | null } = { recusado: null };
  const desfecho = await comIdempotencia({
    db: await createClient(),
    organizationId: org.orgId,
    endpoint: ENDPOINT,
    chave,
    corpo: { id, passo_a_passo: passoAPasso, modo },
    executar: async () => {
      const r = await executar();
      if (!r.ok) {
        estado.recusado = r;
        throw new Error("reinicio_recusado");
      }
      return { resposta: r.enrollment, status: 201 };
    },
  }).catch((e: unknown) => {
    if (estado.recusado) return null;
    throw e;
  });

  if (desfecho === null && estado.recusado) return recusar(estado.recusado);
  if (!desfecho) return fail("internal_error", "Erro ao reiniciar.", 500, { requestId });
  if (desfecho.tipo === "conflito") {
    return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
      requestId,
    });
  }
  if (desfecho.tipo === "em_curso") {
    return fail(
      "idempotency_in_progress",
      t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
      409,
      { requestId },
    );
  }
  return ok(desfecho.resposta, { requestId, status: 201 });
}
