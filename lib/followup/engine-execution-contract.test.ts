import { describe, expect, it, vi } from "vitest";

import { executionContractProblem } from "@/lib/automation/execution-capability";
import { avancarEnrollmentAtivo, type AdminClient } from "./engine";
import { flowGraphSchema } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "./turn-bridge";

const NOW = new Date("2026-10-18T18:00:00Z");

function fixture(graphContract?: 1, enrollmentContract?: 0 | 1) {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: "trigger", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 0 },
        config: { outcome: "exhausted" },
      },
    ],
    edges: [{ id: "edge", source: "trigger", target: "end", condition: { type: "always" } }],
    ...(graphContract ? { execution_contract: graphContract } : {}),
  });
  const enrollment: EnrollmentRow = {
    id: "run",
    organization_id: "org",
    pointer_id: "flow",
    version_id: "version",
    contact_id: "contact",
    conversation_id: null,
    current_node_id: "end",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 0,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...(enrollmentContract === undefined ? {} : { execution_contract: enrollmentContract }),
  };
  const db = {
    loadFlowGraph: vi.fn(async () => graph),
    loadEnrollmentById: vi.fn(async () => enrollment),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadFlowPointerName: vi.fn(async () => "Fluxo"),
    insertDeadInboxItem: vi.fn(async () => {}),
    updateEnrollment: vi.fn(async () => {}),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    criarTarefaInterna: vi.fn(),
    moverLeadNoFunil: vi.fn(),
    editarTagDoLead: vi.fn(),
    applyEnrollmentStep: vi.fn(),
  };
  const enqueueJob = vi.fn(async () => {});
  const run = () =>
    avancarEnrollmentAtivo(
      { db: db as unknown as AdminClient, clock: () => NOW, enqueueJob },
      enrollment,
    );
  const complete = () =>
    completeTurnForEnrollment(
      db as unknown as TurnBridgeAdminClient,
      "org",
      "run",
      "end",
      { kind: "sent" },
      () => NOW,
    );
  return { db, enqueueJob, run, complete };
}

describe("contrato 1 habilitado (EXECUTION_CONTRACT_AVAILABLE)", () => {
  it("grafo 1 + inscrição 1 é aceito; versão desconhecida continua indisponível", () => {
    expect(executionContractProblem({ execution_contract: 1 }, { execution_contract: 1 })).toBeNull();
    expect(executionContractProblem({ execution_contract: 2 }, { execution_contract: 2 })).toBe(
      "execution_contract_unavailable",
    );
  });
});

describe("o motor não executa contrato novo por fallback legado", () => {
  it.each([
    [1, undefined, "execution_contract_mismatch"],
    [undefined, 1, "execution_contract_mismatch"],
  ] as const)(
    "grafo %s / inscrição %s interrompe com motivo %s",
    async (graph, enrollment, reason) => {
      const f = fixture(graph, enrollment);
      await f.run();
      expect(f.db.updateEnrollment).toHaveBeenCalledWith(
        "run",
        "org",
        expect.objectContaining({ status: "dead", last_error: reason }),
      );
      expect(f.db.insertDeadInboxItem).toHaveBeenCalledOnce();
      expect(f.db.loadLeadFacts).not.toHaveBeenCalled();
      expect(f.enqueueJob).not.toHaveBeenCalled();
      expect(f.db.criarTarefaInterna).not.toHaveBeenCalled();
      expect(f.db.moverLeadNoFunil).not.toHaveBeenCalled();
      expect(f.db.editarTagDoLead).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, undefined, "execution_contract_mismatch"],
    [undefined, 1, "execution_contract_mismatch"],
  ] as const)(
    "callback recusa grafo %s / inscrição %s (%s) antes de gravar",
    async (graph, enrollment, reason) => {
      const f = fixture(graph, enrollment);
      await expect(f.complete()).rejects.toThrow(reason);
      expect(f.db.applyEnrollmentStep).not.toHaveBeenCalled();
      expect(f.db.updateEnrollment).not.toHaveBeenCalled();
      expect(f.db.insertEnrollmentEvent).not.toHaveBeenCalled();
    },
  );

  it("inscrição e grafo legados seguem concluindo pelo caminho existente", async () => {
    const f = fixture();
    await f.run();
    expect(f.db.updateEnrollment).toHaveBeenCalledWith(
      "run",
      "org",
      expect.objectContaining({ status: "completed" }),
    );
    expect(f.db.loadLeadFacts).toHaveBeenCalledWith("org", "contact");
    expect(f.db.insertDeadInboxItem).not.toHaveBeenCalled();
  });
});
