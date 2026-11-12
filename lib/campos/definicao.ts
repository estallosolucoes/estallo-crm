import { z } from "zod";

import { customFieldSchema } from "@/lib/schemas/settings";

/**
 * O cadastro central de campos personalizados (`custom_field_definitions`,
 * migration 0657). Lead e contato; a projeção dos de lead em
 * `crm_pipelines.settings.fields` é do banco (`fn_projetar_campos_do_funil`).
 */
export const ENTIDADES_DE_CAMPO = ["lead", "contact"] as const;
export type EntidadeDeCampo = (typeof ENTIDADES_DE_CAMPO)[number];

const TIPOS = customFieldSchema.shape.type.options;
export type TipoDeCampo = (typeof TIPOS)[number];

export const definicaoDeCampoSchema = z
  .object({
    entity: z.enum(ENTIDADES_DE_CAMPO),
    key: customFieldSchema.shape.key.optional(),
    label: z.string().trim().min(1).max(80),
    type: z.enum(TIPOS),
    options: z
      .array(z.object({ value: z.string().trim().min(1), label: z.string().trim().min(1) }))
      .max(100)
      .default([]),
    position: z.number().finite().optional(),
    hidden: z.boolean().default(false),
    visivel_global: z.boolean().default(true),
    funis_visiveis: z.array(z.string().uuid()).max(100).default([]),
    etapas_visiveis: z.array(z.string().uuid()).max(500).default([]),
    obrigatorio: z.enum(["nao", "empresa", "etapas"]).default("nao"),
    etapas_obrigatorias: z.array(z.string().uuid()).max(500).default([]),
    obrigatorio_ao_ganhar: z.boolean().default(false),
    obrigatorio_ao_perder: z.boolean().default(false),
  })
  .strict()
  .refine((d) => !["select", "multiselect"].includes(d.type) || d.options.length > 0, {
    message: "Lista de opções precisa de pelo menos uma opção.",
    path: ["options"],
  });
export type DefinicaoDeCampoInput = z.input<typeof definicaoDeCampoSchema>;

/** PATCH: tudo opcional, menos mudar a entidade ou a chave (os valores já gravados usam a chave). */
export const edicaoDeCampoSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    type: z.enum(TIPOS),
    options: z.array(z.object({ value: z.string().trim().min(1), label: z.string().trim().min(1) })).max(100),
    position: z.number().finite(),
    hidden: z.boolean(),
    visivel_global: z.boolean(),
    funis_visiveis: z.array(z.string().uuid()).max(100),
    etapas_visiveis: z.array(z.string().uuid()).max(500),
    obrigatorio: z.enum(["nao", "empresa", "etapas"]),
    etapas_obrigatorias: z.array(z.string().uuid()).max(500),
    obrigatorio_ao_ganhar: z.boolean(),
    obrigatorio_ao_perder: z.boolean(),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "Nada para alterar." });

export interface DefinicaoDeCampo {
  id: string;
  entity: EntidadeDeCampo;
  key: string;
  label: string;
  type: TipoDeCampo;
  options: Array<{ value: string; label: string }>;
  position: number;
  hidden: boolean;
  visivel_global: boolean;
  funis_visiveis: string[];
  etapas_visiveis: string[];
  obrigatorio: "nao" | "empresa" | "etapas";
  etapas_obrigatorias: string[];
  obrigatorio_ao_ganhar: boolean;
  obrigatorio_ao_perder: boolean;
}

/**
 * A chave que nasce do rótulo: "Qual é sua maior dificuldade?" → "qual_e_sua_maior_dificuldade".
 * Sem acento, minúscula, `_` no lugar do resto, até 40, começando por letra.
 * `ocupadas` evita colisão acrescentando `_2`, `_3`…
 */
export function chaveDoRotulo(rotulo: string, ocupadas: ReadonlySet<string> = new Set()): string {
  let base = rotulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!/^[a-z]/.test(base)) base = `campo_${base}`.slice(0, 36).replace(/_+$/g, "");
  let chave = base;
  for (let n = 2; ocupadas.has(chave); n++) chave = `${base}_${n}`;
  return chave;
}

/**
 * A definição vale para este lead? Global, funil inteiro, ou a etapa dele.
 * O mesmo critério da projeção do banco, para quem lê o cadastro direto
 * (campos de CONTATO no dossiê).
 */
export function campoVisivelNoLead(
  d: Pick<DefinicaoDeCampo, "hidden" | "visivel_global" | "funis_visiveis" | "etapas_visiveis">,
  lead: { pipeline_id: string; stage_id: string } | null,
): boolean {
  if (d.hidden) return false;
  if (d.visivel_global) return true;
  if (!lead) return false;
  return d.funis_visiveis.includes(lead.pipeline_id) || d.etapas_visiveis.includes(lead.stage_id);
}

/** As colunas que a API devolve de `custom_field_definitions`. */
export const COLUNAS_DA_DEFINICAO =
  "id, entity, key, label, type, options, position, hidden, visivel_global, funis_visiveis, etapas_visiveis, obrigatorio, etapas_obrigatorias, obrigatorio_ao_ganhar, obrigatorio_ao_perder";
