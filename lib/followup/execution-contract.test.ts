import { describe, expect, it } from "vitest";

import {
  canTransitionStep,
  effectIdentity,
  executionErrorSchema,
  nodeAttemptSchema,
  recoveryForEffect,
} from "./execution-contract";

const START = "2026-10-18T14:00:00.000Z";
const END = "2026-10-18T14:00:01.000Z";
const attempt = {
  contract_version: 1,
  status: "succeeded",
  started_at: START,
  completed_at: END,
  input: { lead_id: "lead-a" },
  output: { task_id: "task-a" },
};

describe("contrato de execução inspecionável", () => {
  it("normaliza timestamps com offset do banco sem perder a ordem temporal", () => {
    const parsed = nodeAttemptSchema.parse({
      ...attempt,
      started_at: "2026-10-18T17:00:00+03:00",
      completed_at: "2026-10-18T14:00:01+00:00",
    });
    expect(parsed.started_at).toBe(START);
    expect(parsed.completed_at).toBe(END);
  });
  it("exige evidência de saída e separa null de saída não registrada", () => {
    expect(nodeAttemptSchema.safeParse(attempt).success).toBe(true);
    const withoutOutput = { ...attempt };
    delete (withoutOutput as Partial<typeof attempt>).output;
    expect(nodeAttemptSchema.safeParse(withoutOutput).success).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, output: undefined }).success).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, output: null }).success).toBe(true);
  });

  it("preserva objetos, listas e tipos JSON sem converter ausência em vazio", () => {
    const output = { rows: [{ total: 0, flag: false, optional: null }, { text: "" }], empty: [] };
    expect(nodeAttemptSchema.parse({ ...attempt, output }).output).toEqual(output);
    expect(
      nodeAttemptSchema.safeParse({ ...attempt, output: { invalid: undefined } }).success,
    ).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, output: Infinity }).success).toBe(false);
  });

  it("não aceita sucesso com erro nem falha sem diagnóstico", () => {
    const error = {
      code: "task_failed",
      message: "Não foi possível criar a tarefa.",
      category: "transient",
      retryable: true,
    };
    expect(nodeAttemptSchema.safeParse({ ...attempt, error }).success).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, status: "failed" }).success).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, status: "failed", error }).success).toBe(true);
  });

  it("impede reenvio automático de resultado desconhecido", () => {
    const error = {
      code: "delivery_unknown",
      message: "A confirmação não retornou.",
      category: "unknown",
      retryable: false,
    };
    expect(executionErrorSchema.safeParse({ ...error, retryable: true }).success).toBe(false);
    expect(nodeAttemptSchema.safeParse({ ...attempt, status: "unknown", error }).success).toBe(
      true,
    );
    expect(recoveryForEffect("unknown")).toBe("reconcile");
    expect(nodeAttemptSchema.safeParse({ ...attempt, status: "failed", error }).success).toBe(
      false,
    );
    expect(recoveryForEffect("confirmed")).toBe("reuse_result");
    expect(recoveryForEffect("pending")).toBe("await_result");
    expect(recoveryForEffect("failed")).toBe("retry_failed");
  });

  it("valida término, espera e cronologia sem fabricar duração", () => {
    expect(nodeAttemptSchema.safeParse({ ...attempt, completed_at: null }).success).toBe(false);
    expect(
      nodeAttemptSchema.safeParse({ ...attempt, completed_at: "2026-10-18T13:59:00.000Z" }).success,
    ).toBe(false);
    expect(
      nodeAttemptSchema.safeParse({
        ...attempt,
        status: "waiting",
        completed_at: null,
        next_eval_at: END,
      }).success,
    ).toBe(true);
    expect(nodeAttemptSchema.safeParse({ ...attempt, status: "running" }).success).toBe(false);
  });

  it("mantém estados terminais imutáveis e permite rechecagem da mesma passagem", () => {
    expect(canTransitionStep("running", "running")).toBe(true);
    expect(canTransitionStep("waiting", "running")).toBe(true);
    expect(canTransitionStep("pending", "succeeded")).toBe(false);
    for (const state of ["succeeded", "failed", "unknown", "skipped"] as const) {
      expect(canTransitionStep(state, "running")).toBe(false);
      expect(canTransitionStep(state, "succeeded")).toBe(false);
    }
  });
});

describe("identidade de efeitos", () => {
  const identity = {
    organization_id: "org-a",
    root_execution_id: "run-a",
    node_id: "task",
    visit: 1,
    item_key: null,
    operation: "create_task",
  };

  it("recupera a mesma operação e distingue restart, tenant, item e nova visita", () => {
    const key = effectIdentity(identity);
    expect(effectIdentity({ ...identity })).toBe(key);
    expect(effectIdentity({ ...identity, root_execution_id: "restart" })).not.toBe(key);
    expect(effectIdentity({ ...identity, organization_id: "org-b" })).not.toBe(key);
    expect(effectIdentity({ ...identity, visit: 2 })).not.toBe(key);
    expect(effectIdentity({ ...identity, item_key: "row-1" })).not.toBe(key);
  });

  it("não colide por delimitadores e recusa contador inválido", () => {
    expect(effectIdentity({ ...identity, node_id: "a:b", operation: "c" })).not.toBe(
      effectIdentity({ ...identity, node_id: "a", operation: "b:c" }),
    );
    expect(() => effectIdentity({ ...identity, visit: -1 })).toThrow("invalid_effect_visit");
    expect(() => effectIdentity({ ...identity, visit: 0.5 })).toThrow("invalid_effect_visit");
    expect(() => effectIdentity({ ...identity, node_id: "" })).toThrow("missing_effect_identity");
  });
});
