/**
 * As ações do menu de cada conversa no Inbox (16/10/2026): fixar, marcar como
 * não lida, limpar e apagar. As rotas são finas e chamam daqui.
 *
 * Nenhuma delas mexe no WhatsApp do cliente — só no CRM. Limpar e apagar são
 * `manager`+ (decisão do dono do produto); fixar e marcar como não lida, `agent`+.
 * Tudo com o cliente da SESSÃO: a RLS decide o que o ator alcança, e o
 * `organization_id` vem da sessão, nunca do corpo.
 */
import { ApiError } from "@/lib/api/types";
import type { createClient } from "@/lib/supabase/server";

type SB = Awaited<ReturnType<typeof createClient>>;

export interface CtxDaAcao {
  organizationId: string;
  userId: string;
  requestId: string;
}

async function conversaVisivel(supabase: SB, ctx: CtxDaAcao, id: string) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data)
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
}

/** Fixa (idempotente) a conversa no topo da lista de QUEM pede. */
export async function fixarConversa(supabase: SB, ctx: CtxDaAcao, id: string) {
  await conversaVisivel(supabase, ctx, id);
  const { error } = await supabase
    .from("conversation_pins")
    .upsert(
      { organization_id: ctx.organizationId, user_id: ctx.userId, conversation_id: id },
      { onConflict: "user_id,conversation_id", ignoreDuplicates: true },
    );
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
}

export async function desafixarConversa(supabase: SB, ctx: CtxDaAcao, id: string) {
  const { error } = await supabase
    .from("conversation_pins")
    .delete()
    .eq("organization_id", ctx.organizationId)
    .eq("user_id", ctx.userId)
    .eq("conversation_id", id);
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
}

/**
 * Marca como não lida: o contador volta a ser pelo menos 1. É o mesmo contador
 * que a mensagem recebida incrementa — então a conversa reaparece em "Não lidos"
 * e com o selo, como qualquer outra.
 */
export async function marcarComoNaoLida(supabase: SB, ctx: CtxDaAcao, id: string) {
  const { data, error } = await supabase
    .from("conversations")
    .select("unread_count_for_assignee")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data)
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  const atual = (data as { unread_count_for_assignee: number }).unread_count_for_assignee ?? 0;
  if (atual > 0) return;
  const { error: upErr } = await supabase
    .from("conversations")
    .update({ unread_count_for_assignee: 1 })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id);
  if (upErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, upErr.message);
}

/**
 * Limpa a conversa: apaga as mensagens e zera o que delas se derivava (prévia,
 * horários, contador, espera). A conversa — dono, etiquetas, negócio — fica.
 */
export async function limparConversa(supabase: SB, ctx: CtxDaAcao, id: string): Promise<number> {
  await conversaVisivel(supabase, ctx, id);
  const { count, error } = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("organization_id", ctx.organizationId)
    .eq("conversation_id", id);
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  const { error: upErr } = await supabase
    .from("conversations")
    .update({
      last_message_preview: null,
      last_message_at: null,
      last_inbound_at: null,
      last_outbound_at: null,
      unread_count_for_assignee: 0,
      awaiting_since: null,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id);
  if (upErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, upErr.message);
  return count ?? 0;
}

/** Apaga a conversa inteira (mensagens primeiro; o resto é cascade/set null). */
export async function apagarConversa(supabase: SB, ctx: CtxDaAcao, id: string): Promise<number> {
  await conversaVisivel(supabase, ctx, id);
  const { count, error } = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("organization_id", ctx.organizationId)
    .eq("conversation_id", id);
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  const { error: delErr, count: apagadas } = await supabase
    .from("conversations")
    .delete({ count: "exact" })
    .eq("organization_id", ctx.organizationId)
    .eq("id", id);
  if (delErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, delErr.message);
  if (!apagadas)
    throw new ApiError(
      403,
      "forbidden",
      undefined,
      ctx.requestId,
      "Sem permissão para apagar esta conversa.",
    );
  return count ?? 0;
}
