"use client";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import { instanteOtimista } from "@/lib/inbox/ordem-do-fio";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { gravarNaConversaDaLista } from "@/hooks/inbox/recargaDasConversas";
import { previaDaMensagem } from "@/lib/messaging/previa-da-mensagem";
import type { Message } from "@/lib/types/messaging";

interface SendArgs {
  conversation_id: string;
  body?: string;
  media_url?: string;
  media_mime?: string;
  media_storage_path?: string;
  media_size_bytes?: number;
  type?: string;
  /**
   * Definição aprovada — o caminho de volta quando a janela de 24h fechou. A
   * rota já aceitava estes campos; só o front nunca os mandava, então não havia
   * como disparar um modelo pelo inbox.
   */
  template_name?: string;
  template_language?: string;
  template_values?: Record<string, string>;
  /** A mensagem citada — id da NOSSA linha; o handler traduz para o do canal. */
  reply_to_message_id?: string;
  metadata?: Record<string, unknown>;
}

interface MessagesPage {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export const CHAVE_DO_ENVIO = ["send-message"] as const;

export function useSendMessage() {
  const qc = useQueryClient();

  return useMutation({
    // A chave deixa a lista do Inbox saber em que conversa o PRÓPRIO usuário
    // acabou de agir (`useMutationState`), sem passar callback pelo composer.
    mutationKey: CHAVE_DO_ENVIO,
    mutationFn: async (input: SendArgs) =>
      apiClient.post<{ data: Message }>("/api/v1/messages", input),
    onMutate: async (args) => {
      // A prévia da lista acompanha o envio na hora, antes do servidor responder
      // (a mesma régua de prévia que o banco grava). O tique sai como "na fila":
      // o AckIndicator não desenha nada até o status real chegar pelo Realtime.
      const agora = new Date().toISOString();
      gravarNaConversaDaLista(qc, args.conversation_id, {
        last_message_preview: previaDaMensagem(args.body, args.type ?? (args.media_url || args.media_storage_path ? "document" : "text")),
        last_message_at: agora,
        last_outbound_at: agora,
        ultimo_status_de_saida: "queued",
      });

      if (args.media_storage_path || args.media_url || args.type === "contact") return {};

      const queryKey = ["messages", args.conversation_id];
      await qc.cancelQueries({ queryKey });

      const tempId = `temp-${randomId()}`;
      const instante = instanteOtimista(
        qc.getQueryData<InfiniteData<MessagesPage>>(queryKey)?.pages[0]?.data ?? [],
      );
      const tempMsg: Message = {
        id: tempId,
        organization_id: "",
        conversation_id: args.conversation_id,
        channel_session_id: "",
        contact_id: "",
        external_id: null,
        type: args.type ?? "text",
        direction: "outbound",
        status: "queued",
        ack: null,
        error_code: null,
        error_message: null,
        body: args.body ?? null,
        media_url: args.media_url ?? null,
        media_mime: args.media_mime ?? null,
        media_size_bytes: null,
        media_storage_path: null,
        reply_to_message_id: args.reply_to_message_id ?? null,
        sent_via: "user",
        sent_by_user_id: null,
        sent_at: instante,
        delivered_at: null,
        read_at: null,
        metadata: { _optimistic: true },
        // Mensagem que acaba de sair não foi editada nem apagada — mas os
        // campos precisam existir: sem eles o otimista não é do mesmo tipo do
        // que volta do servidor, e a bolha passaria a renderizar dois formatos.
        edited_at: null,
        revoked_at: null,
        created_at: instante,
      };

      qc.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old) return old;
        const pages = [...old.pages];
        if (pages.length > 0) {
          // A primeira página contém as mensagens mais recentes. As páginas
          // seguintes são carregadas para trás no histórico.
          const newest = pages[0]!;
          pages[0] = {
            ...newest,
            data: [...newest.data, tempMsg],
          };
        }
        return { ...old, pages };
      });

      return { tempId };
    },
    onSuccess: (result, args, context) => {
      const real = result.data;
      const queryKey = ["messages", args.conversation_id];
      qc.setQueryData<InfiniteData<MessagesPage>>(queryKey, (old) => {
        if (!old || old.pages.length === 0) return old;
        // O Realtime pode ter buscado a mensagem real antes da resposta do
        // POST. Remover ambas as cópias antes de inseri-la evita duplicação.
        const pages = old.pages.map((page) => ({
          ...page,
          data: page.data.filter((m) => m.id !== context?.tempId && m.id !== real.id),
        }));
        pages[0] = { ...pages[0]!, data: [...pages[0]!.data, real] };
        return { ...old, pages };
      });
    },
    onError: (err, args, context) => {
      if (context?.tempId) {
        qc.setQueryData<InfiniteData<MessagesPage>>(["messages", args.conversation_id], (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  data: page.data.filter((m) => m.id !== context.tempId),
                })),
              }
            : old,
        );
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      qc.invalidateQueries({ queryKey: ["messages", args.conversation_id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      // Responder muda o status do chat (Em espera → Em aberto): o contador das
      // abas precisa cair na hora, não no próximo polling de 30 s.
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    },
  });
}
