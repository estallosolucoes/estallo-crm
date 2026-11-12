import { describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { avancarEnrollmentAtivo, type AdminClient } from "./engine";
import type * as ContractModule from "./execution-contract";
import {
  ExecutionTaskConfigurationError,
  type ExecutionAttemptHandle,
  type ExecutionJournal,
} from "./execution-journal";
import { flowGraphSchema } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";

// Seam de integração: contrato novo segue indisponível no produto. Aqui só a
// indisponibilidade é liberada; divergência entre inscrição e grafo continua recusada.
vi.mock("./execution-contract", async (original) => {
  const contractModule = await original<typeof ContractModule>();
  return {
    ...contractModule,
    executionContractProblem: (...args: Parameters<typeof contractModule.executionContractProblem>) => {
      const problem = contractModule.executionContractProblem(...args);
      return problem === "execution_contract_unavailable" ? null : problem;
    },
  };
});

const NOW = new Date("2026-10-19T01:00:00Z");
function fixture() {
  const graph = flowGraphSchema.parse({
    execution_contract: 1,
    nodes: [
      {
        id: "task",
        type: "internal_task",
        position: { x: 0, y: 0 },
        label: "Tarefa",
        config: {
          titulo: "Ligar",
          vence_em_dias: 1,
          atribuir_a: "dono_do_lead",
          prioridade: "medium",
        },
      },
      {
        id: "end",
        type: "end",
        position: { x: 0, y: 100 },
        label: "Fim",
        config: { outcome: "exhausted" },
      },
    ],
    edges: [{ id: "edge", source: "task", target: "end", condition: { type: "always" } }],
  });
  const scope: EnrollmentRow = {
    id: "run",
    organization_id: "org",
    pointer_id: "flow",
    version_id: "version",
    contact_id: "contact",
    lead_id: "lead",
    conversation_id: null,
    execution_contract: 1,
    revision: 10,
    current_node_id: "task",
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
  };
  const handle: ExecutionAttemptHandle = {
    organization_id: "org",
    enrollment_id: "run",
    step_id: "step",
    attempt_id: "attempt",
    node_id: "task",
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
    completeTask: vi.fn(async () => {
      order.push("commit");
      return { output: { task_id: "task", contact_id: "contact", lead_id: "lead" }, reused: false };
    }),
    fail: vi.fn(async () => {
      order.push("fail");
    }),
  };
  const db = {
    executionJournal: vi.fn(async () => journal),
    loadFlowGraph: vi.fn(async () => graph),
    loadLeadFacts: vi.fn(),
    loadRenderContext: vi.fn(),
    insertEnrollmentEvent: vi.fn(),
    updateEnrollment: vi.fn(),
    criarTarefaInterna: vi.fn(),
    moverLeadNoFunil: vi.fn(),
    editarTagDoLead: vi.fn(),
  };
  const enqueueJob = vi.fn();
  const run = () =>
    avancarEnrollmentAtivo(
      { db: db as unknown as AdminClient, clock: () => NOW, enqueueJob },
      scope,
    );
  return { scope, handle, journal, db, order, run, enqueueJob };
}

describe("nó Criar tarefa usa o diário no motor existente", () => {
  it("persiste a tentativa antes do commit e não percorre os escritores legados", async () => {
    const f = fixture();
    await f.run();
    expect(f.order).toEqual(["begin", "commit"]);
    expect(f.journal.begin).toHaveBeenCalledWith(f.scope, {
      contact_id: "contact",
      lead_id: "lead",
      conversation_id: null,
    });
    expect(f.journal.completeTask).toHaveBeenCalledWith(f.scope, f.handle);
    expect(f.db.loadLeadFacts).not.toHaveBeenCalled();
    expect(f.db.criarTarefaInterna).not.toHaveBeenCalled();
    expect(f.db.insertEnrollmentEvent).not.toHaveBeenCalled();
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
    expect(f.enqueueJob).not.toHaveBeenCalled();
  });

  it("falha de configuração é entregue ao diário com diagnóstico e sem avanço legado", async () => {
    const f = fixture();
    f.journal.completeTask.mockRejectedValue(new ExecutionTaskConfigurationError("sem_dono"));
    await f.run();
    expect(f.order).toEqual(["begin", "fail"]);
    expect(f.journal.fail).toHaveBeenCalledWith(
      f.scope,
      f.handle,
      expect.objectContaining({ code: "sem_dono", category: "configuration", retryable: false }),
    );
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
  });

  it("falha de escrita não é transformada em sucesso nem expõe o erro cru", async () => {
    const f = fixture();
    f.journal.completeTask.mockRejectedValue(new Error("erro privado do driver"));
    await f.run();
    expect(f.journal.fail).toHaveBeenCalledWith(f.scope, f.handle, {
      code: "execution_task_write_failed",
      message: "Não foi possível confirmar a tarefa nesta tentativa.",
      category: "transient",
      retryable: true,
    });
    expect(f.db.criarTarefaInterna).not.toHaveBeenCalled();
  });

  it("worker obsoleto não grava outra falha nem altera a decisão humana", async () => {
    const f = fixture();
    f.journal.completeTask.mockRejectedValue(new StaleServiceBoundaryError());
    await f.run();
    expect(f.journal.fail).not.toHaveBeenCalled();
    expect(f.db.updateEnrollment).not.toHaveBeenCalled();
  });

  it.each(["reconcile", "stopped"] as const)(
    "%s impede executar a tarefa novamente",
    async (kind) => {
      const f = fixture();
      f.journal.begin.mockResolvedValue({ kind, step_id: "step", attempt_id: "attempt" });
      await f.run();
      expect(f.journal.completeTask).not.toHaveBeenCalled();
      expect(f.journal.fail).not.toHaveBeenCalled();
      expect(f.db.updateEnrollment).not.toHaveBeenCalled();
    },
  );
});
