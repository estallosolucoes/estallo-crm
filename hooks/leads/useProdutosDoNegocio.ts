"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import type { ItemDoRascunho } from "@/lib/leads/rascunho-de-produtos";
import type { ProdutoDoNegocio } from "@/lib/schemas/produtos-do-negocio";

/** O que o seletor e o filtro precisam de um produto do catálogo. */
export interface ProdutoDoCatalogo {
  id: string;
  nome: string;
  preco_cents: number;
  ativo: boolean;
}

/**
 * O catálogo inteiro da organização (a rota devolve até 500, ativos primeiro).
 * Cache de 5 min: o card e o filtro do quadro leem a mesma lista.
 */
export function useCatalogoDeProdutos(enabled = true) {
  return useQuery({
    queryKey: ["catalogo-de-produtos"],
    queryFn: async () =>
      (await apiClient.get<ApiSuccess<ProdutoDoCatalogo[]>>("/api/v1/products")).data,
    staleTime: 5 * 60_000,
    enabled,
  });
}

const chave = (leadId: string) => ["produtos-do-negocio", leadId] as const;

/** Chave e busca dos produtos — as mesmas para o hook e para o prefetch do card. */
export function opcoesDosProdutosDoNegocio(leadId: string) {
  return {
    queryKey: chave(leadId),
    queryFn: async ({ signal }: { signal?: AbortSignal }) =>
      (
        await apiClient.get<ApiSuccess<ProdutoDoNegocio[]>>(`/api/v1/leads/${leadId}/produtos`, {
          signal,
        })
      ).data,
  };
}

/**
 * Os produtos de um negócio, e cada ação gravando NA HORA (30/10/2026): a lista
 * muda na tela antes do servidor responder; erro devolve a lista de antes e
 * mostra o motivo. Depois de cada ação o quadro é relido — o valor do negócio
 * muda pela trigger do banco (soma dos produtos) e o filtro por produto lê
 * `produtos_ids` do quadro.
 */
export function useProdutosDoNegocio(leadId: string, pipelineId: string) {
  const qc = useQueryClient();
  const query = useQuery(opcoesDosProdutosDoNegocio(leadId));

  async function otimista(
    mudar: (lista: ItemDoRascunho[]) => ItemDoRascunho[],
    chamada: () => Promise<unknown>,
  ): Promise<boolean> {
    await qc.cancelQueries({ queryKey: chave(leadId) });
    const antes = qc.getQueryData<ProdutoDoNegocio[]>(chave(leadId));
    qc.setQueryData<ItemDoRascunho[]>(chave(leadId), (l) => mudar(l ?? []));
    try {
      await chamada();
      return true;
    } catch (erro) {
      qc.setQueryData(chave(leadId), antes);
      showApiError(erro);
      return false;
    } finally {
      void qc.invalidateQueries({ queryKey: chave(leadId) });
      void qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
    }
  }

  /** `item` já vem com id `novo-…`: é ele que aparece até o id real voltar. */
  const adicionar = (item: ItemDoRascunho) =>
    otimista(
      (l) => [...l, item],
      () =>
        apiClient.post(`/api/v1/leads/${leadId}/produtos`, {
          product_id: item.product_id,
          quantidade: item.quantidade,
          desconto_cents: item.desconto_cents,
        }),
    );

  const remover = (itemId: string) =>
    otimista(
      (l) => l.filter((i) => i.id !== itemId),
      () => apiClient.delete(`/api/v1/leads/${leadId}/produtos/${itemId}`),
    );

  const alterar = (itemId: string, campos: { quantidade?: number; desconto_cents?: number }) =>
    otimista(
      (l) => l.map((i) => (i.id === itemId ? { ...i, ...campos } : i)),
      () => apiClient.patch(`/api/v1/leads/${leadId}/produtos/${itemId}`, campos),
    );

  return { ...query, adicionar, remover, alterar };
}
