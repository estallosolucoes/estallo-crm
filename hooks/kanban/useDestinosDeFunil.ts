"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface DestinoDeFunil {
  id: string;
  name: string;
  /** As etapas abertas do funil, na ordem do quadro. */
  etapas?: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Para onde este lead pode ir — `GET /api/v1/leads/[id]/clone`
 * (`pipeline.move_card`, agent+). Só busca quando o diálogo está aberto
 * (`enabled`): não há razão para carregar a lista de funis a cada render do
 * menu do card.
 */
export function useDestinosDeFunil(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["lead", leadId, "clone-destinos"],
    queryFn: async () =>
      apiClient.get<{ data: { pipelines: DestinoDeFunil[] } }>(
        `/api/v1/leads/${leadId}/clone`,
      ),
    enabled,
    staleTime: 30_000,
    select: (res) => res.data.pipelines,
  });
}
