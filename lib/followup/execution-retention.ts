import { z } from "zod";
import { executionTimestampSchema } from "./execution-contract";

/** Fonte de configuração: organizations.settings.automations.retention. */
export const EXECUTION_RETENTION_DEFAULTS = { payload_days: 30, metadata_days: 180 } as const;
export const EXECUTION_RETENTION_LIMITS = {
  payload_min: 1,
  payload_max: 365,
  metadata_min: 30,
  metadata_max: 1825,
} as const;

const retentionFields = {
  payload_days: z
    .number()
    .int()
    .min(EXECUTION_RETENTION_LIMITS.payload_min)
    .max(EXECUTION_RETENTION_LIMITS.payload_max),
  metadata_days: z
    .number()
    .int()
    .min(EXECUTION_RETENTION_LIMITS.metadata_min)
    .max(EXECUTION_RETENTION_LIMITS.metadata_max),
};
const validOrder = (policy: { payload_days: number; metadata_days: number }) =>
  policy.metadata_days >= policy.payload_days;
const orderError = {
  path: ["metadata_days"],
  message: "O histórico deve ser mantido por pelo menos o prazo dos dados detalhados.",
};

export const executionRetentionSchema = z
  .strictObject({
    payload_days: retentionFields.payload_days.default(EXECUTION_RETENTION_DEFAULTS.payload_days),
    metadata_days: retentionFields.metadata_days.default(
      EXECUTION_RETENTION_DEFAULTS.metadata_days,
    ),
  })
  .refine(validOrder, orderError);

/** Escrita exige os dois prazos: omissão não deve reduzir uma política existente. */
export const executionRetentionUpdateSchema = z
  .strictObject(retentionFields)
  .refine(validOrder, orderError);

export type ExecutionRetentionPolicy = z.infer<typeof executionRetentionSchema>;
export interface ExecutionRetentionView {
  policy: ExecutionRetentionPolicy;
  configuration_valid: boolean;
  limits: typeof EXECUTION_RETENTION_LIMITS;
}

/** Configuração corrompida não derruba o motor; a superfície recebe o aviso de invalidade. */
export function readExecutionRetention(raw: unknown): {
  policy: ExecutionRetentionPolicy;
  configuration_valid: boolean;
} {
  const parsed = executionRetentionSchema.safeParse(raw === undefined ? {} : raw);
  return parsed.success
    ? { policy: parsed.data, configuration_valid: true }
    : { policy: { ...EXECUTION_RETENTION_DEFAULTS }, configuration_valid: false };
}

/** Só execuções encerradas têm relógio de expiração de payload. */
export function executionPayloadExpiresAt(
  completedAt: string | null,
  policy: ExecutionRetentionPolicy,
): string | null {
  if (completedAt === null) return null;
  const timestamp = executionTimestampSchema.parse(completedAt);
  const { payload_days } = executionRetentionSchema.parse(policy);
  return new Date(Date.parse(timestamp) + payload_days * 86_400_000).toISOString();
}
