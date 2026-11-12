import { z } from "zod";

/** Versão do contrato de resultados, independente da versão publicada do fluxo. */
export const EXECUTION_CONTRACT_VERSION = 1;
/** Liberar somente após a integração do executor e seus invariantes de efeitos. */
export {
  EXECUTION_CONTRACT_AVAILABLE,
  executionContractProblem,
} from "@/lib/automation/execution-capability";

export const STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "skipped",
  "failed",
  "unknown",
] as const;
export const ATTEMPT_STATUSES = [
  "running",
  "waiting",
  "succeeded",
  "skipped",
  "failed",
  "unknown",
] as const;
export const EFFECT_STATUSES = ["pending", "confirmed", "failed", "unknown"] as const;
export const EXECUTION_MODES = ["production", "simulation", "test"] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export const executionErrorSchema = z
  .strictObject({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    category: z.enum(["configuration", "transient", "blocked", "unknown"]),
    retryable: z.boolean(),
    request_id: z.string().max(200).optional(),
    details: z.json().optional(),
  })
  .superRefine((error, ctx) => {
    if (error.category === "unknown" && error.retryable) {
      ctx.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "Resultado desconhecido exige reconciliação antes de repetir.",
      });
    }
  });

export type ExecutionError = z.infer<typeof executionErrorSchema>;

/** PostgREST pode devolver +00:00; a superfície sempre recebe ISO UTC com Z. */
export const executionTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const utcTimestamp = executionTimestampSchema;

/** Snapshots são dados de domínio; credenciais não pertencem a este contrato. */
export const nodeAttemptSchema = z
  .strictObject({
    contract_version: z.literal(EXECUTION_CONTRACT_VERSION),
    status: z.enum(ATTEMPT_STATUSES),
    started_at: utcTimestamp,
    completed_at: utcTimestamp.nullable(),
    input: z.json(),
    output: z.json().optional(),
    error: executionErrorSchema.optional(),
    branch_id: z.string().min(1).max(100).optional(),
    next_eval_at: utcTimestamp.optional(),
  })
  .superRefine((attempt, ctx) => {
    const terminal = ["succeeded", "skipped", "failed", "unknown"].includes(attempt.status);
    if (terminal !== (attempt.completed_at !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "O término deve corresponder ao estado terminal da tentativa.",
      });
    }
    if (attempt.completed_at && Date.parse(attempt.completed_at) < Date.parse(attempt.started_at)) {
      ctx.addIssue({
        code: "custom",
        path: ["completed_at"],
        message: "O término não pode anteceder o início.",
      });
    }
    if (attempt.status === "succeeded" && attempt.output === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["output"],
        message: "Sucesso exige uma saída registrada, inclusive quando ela é null.",
      });
    }
    if ((attempt.status === "failed" || attempt.status === "unknown") && !attempt.error) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "Falha ou resultado desconhecido exige erro estruturado.",
      });
    }
    if ((attempt.status === "succeeded" || attempt.status === "skipped") && attempt.error) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "Uma tentativa concluída não pode esconder uma falha.",
      });
    }
    if (attempt.error?.category === "unknown" && attempt.status !== "unknown") {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Um efeito incerto não pode ser classificado como falha segura para repetir.",
      });
    }
    if (attempt.status === "unknown" && attempt.error?.category !== "unknown") {
      ctx.addIssue({
        code: "custom",
        path: ["error", "category"],
        message: "Resultado incerto deve ser identificado como desconhecido.",
      });
    }
  });

export type NodeAttempt = z.infer<typeof nodeAttemptSchema>;

/** Uma rechecagem running→running não cria outra visita ao nó. Estados terminais são imutáveis. */
const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["running", "skipped"],
  running: ["running", "waiting", "succeeded", "skipped", "failed", "unknown"],
  waiting: ["running"],
  succeeded: [],
  skipped: [],
  failed: [],
  unknown: [],
};

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export type EffectRecovery = "reuse_result" | "retry_failed" | "await_result" | "reconcile";

export function recoveryForEffect(status: EffectStatus): EffectRecovery {
  switch (status) {
    case "confirmed":
      return "reuse_result";
    case "failed":
      return "retry_failed";
    case "pending":
      return "await_result";
    case "unknown":
      return "reconcile";
  }
}

/**
 * Não recebe tentativa, job ou hora: recuperação herda a identidade do efeito.
 * O restart usa outra execução raiz. JSON evita colisão por delimitadores em IDs.
 */
export function effectIdentity(input: {
  organization_id: string;
  root_execution_id: string;
  node_id: string;
  visit: number;
  item_key: string | null;
  operation: string;
}): string {
  if (!Number.isSafeInteger(input.visit) || input.visit < 0) {
    throw new Error("invalid_effect_visit");
  }
  for (const value of [
    input.organization_id,
    input.root_execution_id,
    input.node_id,
    input.operation,
  ]) {
    if (!value) throw new Error("missing_effect_identity");
  }
  return JSON.stringify([
    EXECUTION_CONTRACT_VERSION,
    input.organization_id,
    input.root_execution_id,
    input.node_id,
    input.visit,
    input.item_key,
    input.operation,
  ]);
}
