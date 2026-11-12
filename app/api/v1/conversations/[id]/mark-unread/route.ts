import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/mark-unread — o contador de não lidas volta a pelo menos 1.
 *
 * Menu de ações da conversa no Inbox (16/10/2026). A lógica mora em
 * `lib/inbox/acoes-da-conversa.ts`; aqui só papel, auditoria e resposta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { marcarComoNaoLida } from "@/lib/inbox/acoes-da-conversa";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const supabase = await createClient();

  try {
    const resultado = await marcarComoNaoLida(
      supabase,
      { organizationId: authz.org.orgId, userId: authz.user.id, requestId },
      id,
    );
    void audit({
      action: "conversation.marked_unread",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
    });
    return ok({ id, resultado: resultado ?? null }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
