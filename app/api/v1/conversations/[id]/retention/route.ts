/**
 * GET /api/v1/conversations/[id]/retention — vetos recentes da cadeia before_send
 * para o contato desta conversa (Operação Visível F2-i). Read-only, RLS-scoped
 * (client de sessão): responde POR QUE a resposta do assistente foi retida.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Só vetos recentes interessam à tela — mais velho que isso é histórico, não aviso. */
const RETENTION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id, contact_id, channel_session_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (convErr) {
    return fail("internal_error", t("Failed to load conversation."), 500, { requestId });
  }
  if (!conv) {
    return fail("not_found", t("Conversation not found."), 404, { requestId });
  }

  const since = new Date(Date.now() - RETENTION_LOOKBACK_MS).toISOString();
  const { data: traces, error: traceErr } = await supabase
    .from("before_send_traces")
    .select("id, created_at, vetoed_gate, vetoed_code")
    .eq("organization_id", activeOrg.orgId)
    .eq("contact_id", conv.contact_id)
    .not("vetoed_gate", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);
  if (traceErr) {
    return fail("internal_error", t("Failed to load retention traces."), 500, { requestId });
  }

  // O aviso diz o estado de AGORA, não o histórico: retenção seguida de uma resposta que saiu já foi resolvida.
  const { data: ultimaSaida } = await supabase
    .from("messages")
    .select("created_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("conversation_id", id)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const saiuDepoisEm = (ultimaSaida as { created_at?: string } | null)?.created_at ?? null;
  const vigentes = (traces ?? []).filter(
    (tr) => saiuDepoisEm === null || Date.parse(tr.created_at) > Date.parse(saiuDepoisEm),
  );

  return ok({ retentions: vigentes }, { requestId });
}
