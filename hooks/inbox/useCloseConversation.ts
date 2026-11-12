"use client";
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { contagensDepoisDe, type ConversaParaAba } from "@/lib/inbox/aba-da-conversa";
import type { Conversation } from "@/lib/types/messaging";
import type { ConversationCounts } from "@/hooks/inbox/useConversationCounts";

interface CloseArgs {
  conversation_id: string;
  expected_revision?: number;
}

/** A conversa como está no cache (lista ou aberta) — de onde sai a aba atual. */
function conversaEmCache(qc: QueryClient, id: string): ConversaParaAba | null {
  const aberta = qc.getQueryData<{ data?: ConversaParaAba } | ConversaParaAba>(["conversation", id]);
  if (aberta && "data" in aberta && aberta.data) return aberta.data;
  if (aberta && "status" in aberta) return aberta;
  for (const [, lista] of qc.getQueriesData<InfiniteData<{ data: Array<ConversaParaAba & { id: string }> }>>({
    queryKey: ["conversations"],
  })) {
    const achada = lista?.pages?.flatMap((p) => p.data).find((c) => c.id === id);
    if (achada) return achada;
  }
  return null;
}

/**
 * As contagens das abas mudam NA HORA ao fechar/reabrir ("Em espera" 27 → 26,
 * "Fechadas" 0 → 1), sem esperar o servidor. A recarga do `onSettled` traz o
 * número do banco, que é quem manda; o erro também recarrega.
 */
function ajustarContagens(qc: QueryClient, id: string, novoStatus: string): void {
  const conversa = conversaEmCache(qc, id);
  if (!conversa) return;
  qc.setQueriesData<ConversationCounts>({ queryKey: ["conversation-counts"] }, (old) =>
    old ? contagensDepoisDe(old, conversa, novoStatus) : old,
  );
}

function recarregar(qc: QueryClient, id: string): void {
  qc.invalidateQueries({ queryKey: ["conversations"] });
  qc.invalidateQueries({ queryKey: ["conversation", id] });
  qc.invalidateQueries({ queryKey: ["conversation-counts"] });
}

export function useCloseConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: CloseArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/close`,
        { expected_revision: args.expected_revision },
      ),
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: ["conversation-counts"] });
      ajustarContagens(qc, args.conversation_id, "closed");
    },
    onError: (err, args) => {
      recarregar(qc, args.conversation_id);
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      recarregar(qc, args.conversation_id);
    },
  });
}

/** Reabertura explícita preserva as proteções de automação do contato. */
export function useReopenConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: CloseArgs) => apiClient.patch<{ data: Conversation }>(
      `/api/v1/conversations/${args.conversation_id}`,
      { status: "open", expected_revision: args.expected_revision },
    ),
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: ["conversation-counts"] });
      ajustarContagens(qc, args.conversation_id, "open");
    },
    onError: showApiError,
    onSettled: (_data, _error, args) => {
      recarregar(qc, args.conversation_id);
    },
  });
}
