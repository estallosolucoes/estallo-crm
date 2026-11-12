import { z } from "zod";

import type { NodeType } from "./graph-schema";

const id = z.uuidv4();
const utc = z.iso.datetime();
const branch = z.string().min(1).max(100);

/**
 * Saídas declaradas do contrato 1, ainda desabilitado no executor.
 * Não convertem eventos legados em resultados nem afirmam que um efeito ocorreu.
 * O executor valida o resultado real antes de registrar sucesso; o inspetor e o
 * seletor de variáveis consomem os mesmos schemas, sem manter cópias em JSON.
 */
export const NODE_OUTPUT_CONTRACTS = {
  trigger: z.strictObject({
    contact_id: id,
    lead_id: id.nullable(),
    conversation_id: id.nullable(),
  }),
  wait: z.strictObject({
    mode: z.enum(["fixed", "smart", "until"]),
    scheduled_for: utc.nullable(),
    resumed_at: utc,
  }),
  condition: z.strictObject({
    matched: z.boolean(),
    branch_id: branch,
    checks: z.array(
      z.strictObject({ index: z.number().int().nonnegative(), matched: z.boolean() }),
    ),
  }),
  ai_classify: z
    .strictObject({
      classification: z.string().min(1).nullable(),
      branch_id: branch,
      reason: z.enum(["classified", "no_reply"]),
    })
    .superRefine((value, ctx) => {
      if ((value.reason === "no_reply") !== (value.classification === null)) {
        ctx.addIssue({
          code: "custom",
          path: ["classification"],
          message: "Sem resposta não produz uma classificação de IA.",
        });
      }
    }),
  match_reply: z.strictObject({
    matched: z.boolean(),
    branch_id: branch,
    reply_message_id: id.nullable(),
  }),
  repeat: z
    .strictObject({
      index: z.number().int().nonnegative().nullable(),
      total: z.number().int().nonnegative().nullable(),
      branch_id: branch,
      reason: z.enum(["body", "done", "unreadable"]),
    })
    .superRefine((value, ctx) => {
      if (
        value.reason === "unreadable"
          ? value.index !== null || value.total !== null
          : value.index === null ||
            value.total === null ||
            (value.reason === "body" && (value.index === 0 || value.index > value.total)) ||
            (value.reason === "done" && value.index < value.total)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["index"],
          message: "A volta deve corresponder ao total de repetições.",
        });
      }
    }),
  // Atendimento conserva o executor atual. Não prometer output antes de instrumentá-lo.
  collect: null,
  skill: null,
  action: z.strictObject({
    messages: z.array(z.strictObject({ message_id: id, accepted_at: utc })).min(1),
  }),
  internal_task: z.strictObject({ task_id: id, contact_id: id, lead_id: id.nullable() }),
  move_lead: z.strictObject({ lead_id: id, from_stage_id: id.nullable(), to_stage_id: id }),
  edit_lead_tag: z.strictObject({
    // `null` só quando o bloco grava no contato (`destino: "contato"`).
    lead_id: id.nullable(),
    contact_id: id.optional(),
    added_tags: z.array(z.string().min(1)),
    removed_tags: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)),
  }),
  find_or_create_contact: z.strictObject({
    /** O contato achado ou criado; `null` quando não achou e não era para criar. */
    contact_id: id.nullable(),
    encontrado: z.boolean(),
    criado: z.boolean(),
  }),
  find_or_create_lead: z.strictObject({
    lead_id: id.nullable(),
    contact_id: id,
    encontrado: z.boolean(),
    criado: z.boolean(),
  }),
  http_request: z.strictObject({
    /** Status HTTP da resposta (só 2xx chega aqui: o resto é falha do bloco). */
    status: z.number().int(),
    /** O corpo: JSON lido, ou o texto; `null` se passou do teto. */
    corpo: z.json().nullable(),
    truncado: z.boolean(),
  }),
  lead_product: z.strictObject({
    lead_id: id,
    product_id: id,
    acao: z.enum(["add", "remove"]),
    /** O item criado (`add`); `null` em `remove`. */
    item_id: id.nullable(),
    /** Quantos itens desse produto saíram (`remove`); 0 em `add`. */
    removidos: z.number().int().nonnegative(),
  }),
  update_lead_field: z.strictObject({
    lead_id: id.nullable(),
    contact_id: id.optional(),
    alvo: z.enum(["custom_field", "deal_value", "contact_field"]),
    // `null` quando o alvo é o contato e a execução não tem negócio.
    chave: z.string().nullable(),
    valor: z.json(),
    valor_anterior: z.json(),
  }),
  add_note: z.strictObject({
    destino: z.enum(["lead_timeline", "conversation_notes"]),
    note_id: id,
    texto: z.string().min(1),
  }),
  assign_lead_owner: z.strictObject({
    lead_id: id,
    previous_owner_user_id: id.nullable(),
    owner_user_id: id,
  }),
  map_data: z.strictObject({
    fields: z.record(
      z.string().min(1),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
    ),
  }),
  end: z.strictObject({
    outcome: z.enum(["converted", "exhausted"]).nullable(),
    note: z.string().nullable(),
  }),
} as const satisfies Record<NodeType, z.ZodType | null>;

export type NodeWithOutput = {
  [T in NodeType]: (typeof NODE_OUTPUT_CONTRACTS)[T] extends null ? never : T;
}[NodeType];

export type NodeOutput<T extends NodeWithOutput> = z.infer<(typeof NODE_OUTPUT_CONTRACTS)[T]>;

/** Contrato declarado, não amostra e não saída histórica. Sem dados de clientes. */
export function declaredNodeOutputSchema(type: NodeType): Record<string, unknown> | null {
  const schema = NODE_OUTPUT_CONTRACTS[type];
  return schema ? z.toJSONSchema(schema) : null;
}
