"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type {
  DefinicaoDeCampo,
  DefinicaoDeCampoInput,
  EntidadeDeCampo,
} from "@/lib/campos/definicao";

export interface FunilDosCampos {
  id: string;
  name: string;
  etapas: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
}

const CHAVE = ["campos-personalizados"] as const;

/** O cadastro central (lead e contato) + os funis e etapas, numa leitura só. */
export function useCamposPersonalizados(entity?: EntidadeDeCampo, enabled = true) {
  return useQuery({
    queryKey: [...CHAVE, entity ?? "todos"],
    queryFn: () =>
      apiClient
        .get<{ data: { definicoes: DefinicaoDeCampo[]; funis: FunilDosCampos[] } }>(
          `/api/v1/custom-fields${entity ? `?entity=${entity}` : ""}`,
        )
        .then((r) => r.data),
    enabled,
    staleTime: 30_000,
  });
}

function useReler() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: CHAVE });
    // A projeção nos funis mudou: dossiê e quadro releem os campos.
    void qc.invalidateQueries({ queryKey: ["board"] });
  };
}

export function useCriarCampo() {
  const reler = useReler();
  return useMutation({
    mutationFn: (input: DefinicaoDeCampoInput) =>
      apiClient.post<{ data: DefinicaoDeCampo }>("/api/v1/custom-fields", input).then((r) => r.data),
    onError: showApiError,
    onSettled: reler,
  });
}

export function useEditarCampo() {
  const reler = useReler();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<DefinicaoDeCampo> }) =>
      apiClient
        .patch<{ data: DefinicaoDeCampo }>(`/api/v1/custom-fields/${id}`, patch)
        .then((r) => r.data),
    onError: showApiError,
    onSettled: reler,
  });
}

export function useApagarCampo() {
  const reler = useReler();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/custom-fields/${id}`),
    onError: showApiError,
    onSettled: reler,
  });
}
