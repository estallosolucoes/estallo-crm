import { describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { avancarEnrollmentAtivo, type AdminClient } from "./engine";
import type * as ContractModule from "./execution-contract";
import type { ExecutionAttemptHandle, ExecutionJournal } from "./execution-journal";
import { flowGraphSchema } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";

// Seam: só a indisponibilidade do contrato 1 é liberada; divergências continuam recusadas.
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

const NOW = new Date("2026-10-19T01:00:00Z");

function fixture(contract: 0 | 1 = 1) {
  const graph = flowGraphSchema.parse({
    ...(contract === 1 ? { execution_contract: 1 } : {}),
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
        position: { x: 0, y: 100 },
        label: "Fim",
        config: { outcome: "exhausted" },
      },
    ],
    edges: [{ id: "edge", source: "send", target: "end", condition: { type: "always" } }],
  });
  const scope = {
    id: "run",
    organization_id: "org",
    pointer_id: "flow",
    version_id: "version",
    contact_id: "contact",
    lead_id: "lead",
    conversation_id: "conv",
    execution_contract: contract,
    revision: 10,
    current_node_id: "send",
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
  } as unknown as EnrollmentRow;
  const handle: ExecutionAttemptHandle = {
    organization_id: "org",
    enrollment_id: "run",
    step_id: "step",
    attempt_id: "attempt",
    node_id: "send",
    visit: 0,
    attempt_no: 1,
    lease_revision: 10,
  };
  const order: string[] = [];
  const journal = {
    begin: vi.fn(async () => {
      order.push("begin");
      return { kind: "ready", handle } as Awaited<ReturnType<ExecutionJournal["begin"]>>;
    }),
    attachJob: vi.fn(async () => {
      order.push("attach");
      return { reused: false };
    }),
    fail: vi.fn(async () => {
      order.push("fail");
    }),
  };
  const db = {
    executionJournal: vi.fn(async () => journal),
    loadFlowGraph: vi.fn(async () => graph),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadRenderContext: vi.fn(async () => ({})),
    loadEnrollmentEvents: vi.fn(async () => []),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    updateEnrollment: vi.fn(async () => {
      order.push("update");
    }),
    assertServiceBoundary: vi.fn(),
  };
  const enqueueJob = vi.fn(async (_job: { payload: Record<string, unknown> }) => {
    order.push("enqueue");
    return { job_id: "job-1" };
  });
  const run = () =>
    avancarEnrollmentAtivo(
      { db: db as unknown as AdminClient, clock: () => NOW, enqueueJob },
      scope,
    );
  return { scope, handle, journal, db, order, run, enqueueJob };
}

describe("nó de envio no contrato 1: tentativa antes da fila, job ligado depois", () => {
  it("begin → enqueue → attachJob → só então o avanço do relógio", async () => {
    const f = fixture();
    await f.run();
    expect(f.order).toEqual(["begin", "enqueue", "attach", "update"]);
    expect(f.journal.attachJob).toHaveBeenCalledWith(f.scope, f.handle, "job-1");
    expect(f.enqueueJob.mock.calls[0]![0].payload).toMatchObject({
      followup_enrollment_id: "run",
      node_id: "send",
      source_step_key: "send:0",
      purpose: "send_message",
    });
  });

  it("legado (sem contrato) não toca o diário e continua enfileirando", async () => {
    const f = fixture(0);
    await f.run();
    expect(f.journal.begin).not.toHaveBeenCalled();
    expect(f.journal.attachJob).not.toHaveBeenCalled();
    expect(f.enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("recusa ao abrir a tentativa (estado velho) NÃO enfileira nada", async () => {
    const f = fixture();
    f.journal.begin.mockRejectedValueOnce(new StaleServiceBoundaryError());
    await f.run();
    expect(f.enqueueJob).not.toHaveBeenCalled();
  });

  it("produtor que não devolve o id do job falha alto, sem marcar a tentativa como falha", async () => {
    const f = fixture();
    f.enqueueJob.mockResolvedValueOnce(undefined as never);
    await expect(f.run()).rejects.toThrow("execution_job_id_unavailable");
    expect(f.journal.fail).not.toHaveBeenCalled();
    expect(f.journal.attachJob).not.toHaveBeenCalled();
  });

  it("falha ao ligar o job propaga e NÃO falha a tentativa (o job já está na fila)", async () => {
    const f = fixture();
    f.journal.attachJob.mockRejectedValueOnce(new Error("db_down"));
    await expect(f.run()).rejects.toThrow("db_down");
    expect(f.journal.fail).not.toHaveBeenCalled();
  });

  it("job órfão por estado velho no attach encerra o tick sem avançar o relógio", async () => {
    const f = fixture();
    f.journal.attachJob.mockRejectedValueOnce(new StaleServiceBoundaryError());
    await f.run();
    expect(f.journal.attachJob).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["begin", "enqueue"]); // sem "update": o relógio não avançou
  });
});
