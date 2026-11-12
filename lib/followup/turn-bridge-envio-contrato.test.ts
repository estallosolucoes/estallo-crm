import { describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import type * as ContractModule from "./execution-contract";
import type { ExecutionJournal } from "./execution-journal";
import { flowGraphSchema } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "./turn-bridge";

// Seam: só a indisponibilidade do contrato 1 é liberada.
vi.mock("./execution-contract", async (original) => {
  const contractModule = await original<typeof ContractModule>();
  return {
    ...contractModule,
    executionContractProblem: (
      ...args: Parameters<typeof contractModule.executionContractProblem>
    ) => {
      const problem = contractModule.executionContractProblem(...args);
      return problem === "execution_contract_unavailable" ? null : problem;
    },
  };
});

const NOW = new Date("2026-10-19T12:00:00Z");
const graph = flowGraphSchema.parse({
  execution_contract: 1,
  nodes: [
    {
      id: "send",
      type: "action",
      position: { x: 0, y: 0 },
      label: "Enviar",
      config: { mode: "text", body: "Olá" },
    },
    {
      id: "end",
      type: "end",
      position: { x: 0, y: 1 },
      label: "Fim",
      config: { outcome: "exhausted" },
    },
  ],
  edges: [{ id: "e", source: "send", target: "end", condition: { type: "always" } }],
});
const classifyGraph = flowGraphSchema.parse({
  execution_contract: 1,
  nodes: [
    {
      id: "send",
      type: "ai_classify",
      position: { x: 0, y: 0 },
      label: "Classificar",
      config: { classes: ["quente"], grace_timeout_ms: 900_000, target: "last_reply" },
    },
    {
      id: "end",
      type: "end",
      position: { x: 0, y: 1 },
      label: "Fim",
      config: { outcome: "exhausted" },
    },
  ],
  edges: [
    { id: "e", source: "send", target: "end", condition: { type: "class_match", value: "quente" } },
  ],
});
const claim = { worker_id: "w", acquired_at: "2026-10-19T12:00:00Z" };

function row(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "run",
    organization_id: "org",
    pointer_id: "p",
    version_id: "v",
    contact_id: "c",
    lead_id: null,
    conversation_id: null,
    execution_contract: 1,
    revision: 3,
    current_node_id: "send",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  } as EnrollmentRow;
}

function setup(loads: (EnrollmentRow | null)[], grafo = graph) {
  const completeSend = vi.fn();
  const completeClassification = vi.fn();
  const journal = { completeSend, completeClassification } as unknown as ExecutionJournal;
  const queue = [...loads];
  const db = {
    loadEnrollmentById: vi.fn(async () => queue.shift() ?? null),
    loadFlowGraph: vi.fn(async () => grafo),
    assertFollowupJob: vi.fn(async () => {}),
    assertServiceBoundary: vi.fn(async () => {}),
    executionJournal: vi.fn(async () => journal),
    updateEnrollment: vi.fn(),
    insertEnrollmentEvent: vi.fn(),
  } as unknown as TurnBridgeAdminClient;
  const run = () =>
    completeTurnForEnrollment(
      db,
      "org",
      "run",
      "send",
      { kind: "sent" },
      () => NOW,
      "job-1",
      claim,
    );
  return { completeSend, completeClassification, db, run };
}

describe("conclusão do envio no contrato 1 pela ponte", () => {
  it("passa o job e o claim ao diário e não usa o avanço legado", async () => {
    const f = setup([row()]);
    f.completeSend.mockResolvedValueOnce({ output: null, reused: false });
    await f.run();
    expect(f.completeSend).toHaveBeenCalledTimes(1);
    expect(f.completeSend.mock.calls[0]!.slice(1)).toEqual(["job-1", claim]);
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
  });

  it("Stale por corrida de revisão: relê a inscrição e conclui na segunda tentativa", async () => {
    const f = setup([row({ revision: 3 }), row({ revision: 4 })]);
    f.completeSend
      .mockRejectedValueOnce(new StaleServiceBoundaryError())
      .mockResolvedValueOnce({ output: null, reused: false });
    await f.run();
    expect(f.completeSend).toHaveBeenCalledTimes(2);
    expect(f.completeSend.mock.calls[1]![0]).toMatchObject({ revision: 4 });
    expect(f.db.assertFollowupJob).toHaveBeenCalledTimes(2);
  });

  it("Stale e a inscrição já saiu do nó: não conclui de novo nem lança", async () => {
    const f = setup([row(), row({ current_node_id: "end" })]);
    f.completeSend.mockRejectedValueOnce(new StaleServiceBoundaryError());
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.completeSend).toHaveBeenCalledTimes(1);
  });

  it("Stale e a inscrição foi pausada: descarta sem concluir", async () => {
    const f = setup([row(), row({ status: "paused_manual" })]);
    f.completeSend.mockRejectedValueOnce(new StaleServiceBoundaryError());
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.completeSend).toHaveBeenCalledTimes(1);
  });

  it("Stale duas vezes propaga (só uma releitura)", async () => {
    const f = setup([row(), row({ revision: 4 })]);
    f.completeSend.mockRejectedValue(new StaleServiceBoundaryError());
    await expect(f.run()).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(f.completeSend).toHaveBeenCalledTimes(2);
  });

  it("erro que não é Stale propaga sem releitura", async () => {
    const f = setup([row()]);
    f.completeSend.mockRejectedValueOnce(new Error("execution_send_receipt_missing"));
    await expect(f.run()).rejects.toThrow("execution_send_receipt_missing");
    expect(f.completeSend).toHaveBeenCalledTimes(1);
  });
});

describe("plano de tempo fora do acionamento falha fechado no contrato 1", () => {
  it.each([[{ kind: "planned", propostas: [], modelo: "m" }]] as const)(
    "%j num nó que não é o acionamento não avança por caminho nenhum",
    async (result) => {
      const f = setup([row()]);
      await expect(
        completeTurnForEnrollment(
          f.db,
          "org",
          "run",
          "send",
          result as never,
          () => NOW,
          "job-1",
          claim,
        ),
      ).rejects.toThrow("não é 'trigger'");
      expect(f.db.updateEnrollment).not.toHaveBeenCalled();
      expect(f.db.insertEnrollmentEvent).not.toHaveBeenCalled();
      expect(f.completeSend).not.toHaveBeenCalled();
    },
  );
});

describe("classificação por IA no contrato 1 pela ponte", () => {
  const concluir = (f: ReturnType<typeof setup>, result: unknown) =>
    completeTurnForEnrollment(
      f.db,
      "org",
      "run",
      "send",
      result as never,
      () => NOW,
      "job-1",
      claim,
    );

  it("`classified` vai ao diário com job, classe e claim, e não usa o avanço legado", async () => {
    const f = setup([row()], classifyGraph);
    f.completeClassification.mockResolvedValueOnce({ output: null, reused: false });
    await concluir(f, { kind: "classified", class: "quente" });
    expect(f.completeClassification).toHaveBeenCalledTimes(1);
    expect(f.completeClassification.mock.calls[0]!.slice(1)).toEqual(["job-1", "quente", claim]);
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
    expect(f.db.insertEnrollmentEvent).not.toHaveBeenCalled();
  });

  it("Stale: relê a inscrição uma vez; se ela já saiu do nó, descarta sem lançar", async () => {
    const f = setup([row(), row({ current_node_id: "end" })], classifyGraph);
    f.completeClassification.mockRejectedValueOnce(new StaleServiceBoundaryError());
    await expect(concluir(f, { kind: "classified", class: "quente" })).resolves.toBeUndefined();
    expect(f.completeClassification).toHaveBeenCalledTimes(1);
  });

  it("Stale por corrida de revisão: conclui na segunda tentativa com a inscrição relida", async () => {
    const f = setup([row({ revision: 3 }), row({ revision: 4 })], classifyGraph);
    f.completeClassification
      .mockRejectedValueOnce(new StaleServiceBoundaryError())
      .mockResolvedValueOnce({ output: null, reused: false });
    await concluir(f, { kind: "classified", class: "quente" });
    expect(f.completeClassification).toHaveBeenCalledTimes(2);
    expect(f.completeClassification.mock.calls[1]![0]).toMatchObject({ revision: 4 });
  });

  it("sem diário disponível, falha fechada em vez de avançar por fora dele", async () => {
    const f = setup([row()], classifyGraph);
    (f.db as { executionJournal?: unknown }).executionJournal = undefined;
    await expect(concluir(f, { kind: "classified", class: "quente" })).rejects.toThrow(
      "execution_journal_unavailable",
    );
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
  });
});
