import type { ProdutoDoNegocio } from "@/lib/schemas/produtos-do-negocio";

/**
 * Um produto do negócio como a ficha o mostra. Desde 30/10/2026 cada ação
 * (adicionar, remover, alterar) grava NA HORA, de forma otimista
 * (`useProdutosDoNegocio`); a linha recém-adicionada aparece com id `novo-…`
 * até o servidor devolver o id do banco.
 */
export type ItemDoRascunho = Pick<
  ProdutoDoNegocio,
  "id" | "product_id" | "nome" | "quantidade" | "preco_unitario_cents" | "desconto_cents"
>;

/** Linha que ainda não existe no banco (o POST está em voo). */
export const ehNovoNoRascunho = (id: string) => id.startsWith("novo-");
