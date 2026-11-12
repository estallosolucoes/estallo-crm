"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/**
 * Nomes dos produtos do catálogo da organização, para a regra de condição "produto do negócio".
 *
 * O valor gravado na regra é o NOME: o motor compara com o `nome` do item do negócio, que foi
 * COPIADO do catálogo ao vincular (migration 0660). Renomear o produto no catálogo depois não
 * reescreve negócio já montado — por isso a tela avisa quando o nome gravado não está mais na lista.
 */
export interface ProdutosDoCatalogo {
  produtos: Array<{ id: string; nome: string; ativo: boolean }>;
  carregando: boolean;
  falhou: boolean;
}

export function useProdutosDoCatalogo(habilitado = true): ProdutosDoCatalogo {
  const q = useQuery({
    queryKey: ["catalog-products", "nomes-para-fluxo"],
    queryFn: async () =>
      apiClient.get<{ data: Array<{ id: string; nome: string; ativo: boolean }> }>("/api/v1/products"),
    staleTime: 60_000,
    enabled: habilitado,
  });
  return { produtos: q.data?.data ?? [], carregando: q.isLoading, falhou: q.isError };
}
