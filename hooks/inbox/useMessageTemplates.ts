"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
}

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates(ligado = true) {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar && ligado,
    queryKey: ["message-templates"],
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

interface PaginaDeTemplates {
  data: MessageTemplate[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

/**
 * A tela de Respostas rápidas: 30 por vez, mais ao rolar, e a busca vai ao
 * BANCO — encontra o que ainda não foi carregado. A chave começa por
 * `["message-templates"]`, então criar/editar/apagar (que invalidam esse
 * prefixo) também renova esta lista.
 */
export function useMessageTemplatesPaginados(busca: string) {
  const podeConsultar = usePermission("message-templates.view");
  return useInfiniteQuery({
    enabled: podeConsultar,
    queryKey: ["message-templates", "paginas", busca],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: "30" });
      if (busca) qs.set("q", busca);
      if (pageParam) qs.set("cursor", pageParam);
      return apiClient.get<PaginaDeTemplates>(`/api/v1/message-templates?${qs.toString()}`);
    },
    getNextPageParam: (ultima) => (ultima.meta?.has_more ? (ultima.meta.cursor ?? undefined) : undefined),
    // A busca nova mantém a lista anterior até a resposta chegar — sem piscar.
    placeholderData: (anterior) => anterior,
  });
}
