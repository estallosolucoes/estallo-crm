"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import type { NovaConexaoHttp } from "@/lib/followup/requisicao-http";

/** Uma conexão como a rota devolve: sem segredo, só os 4 últimos caracteres. */
export interface ConexaoHttp {
  id: string;
  label: string;
  base_url: string;
  auth_kind: "none" | "bearer" | "header" | "basic";
  header_name: string | null;
  secret_last4: string | null;
}

const CHAVE = ["followup-http-connections"] as const;
const ROTA = "/api/v1/ai/followup-http-connections";

export function useConexoesHttp() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<ApiSuccess<ConexaoHttp[]>>(ROTA)).data,
    staleTime: 60_000,
  });
}

export function useCriarConexaoHttp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NovaConexaoHttp) => (await apiClient.post<ApiSuccess<ConexaoHttp>>(ROTA, input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (e) => showApiError(e),
  });
}

export function useApagarConexaoHttp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`${ROTA}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: (e) => showApiError(e),
  });
}
