import { z } from "zod";

/**
 * Produtos do negócio (0660) — o contrato lido pela tela E pelas rotas.
 *
 * O preço NÃO entra pelo corpo: a rota o copia do catálogo, que é a fonte. O
 * corpo só escolhe o produto, a quantidade e o desconto (em centavos, por item).
 */
export const produtoDoNegocioCreateSchema = z
  .object({
    product_id: z.string().uuid(),
    quantidade: z.number().int().min(1).max(100_000).optional(),
    desconto_cents: z.number().int().min(0).optional(),
  })
  .strict();

export const produtoDoNegocioUpdateSchema = z
  .object({
    quantidade: z.number().int().min(1).max(100_000).optional(),
    desconto_cents: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => v.quantidade !== undefined || v.desconto_cents !== undefined, {
    message: "Nada para alterar.",
  });

export const COLUNAS_DO_PRODUTO_DO_NEGOCIO =
  "id, lead_id, product_id, nome, quantidade, preco_unitario_cents, desconto_cents, created_at";

export interface ProdutoDoNegocio {
  id: string;
  lead_id: string;
  product_id: string | null;
  nome: string;
  quantidade: number;
  preco_unitario_cents: number;
  desconto_cents: number;
  created_at: string;
}

/** O total de um item: quantidade × preço − desconto, nunca negativo (a mesma conta da trigger). */
export function totalDoItem(
  i: Pick<ProdutoDoNegocio, "quantidade" | "preco_unitario_cents" | "desconto_cents">,
): number {
  return Math.max(i.quantidade * i.preco_unitario_cents - i.desconto_cents, 0);
}
