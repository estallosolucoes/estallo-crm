/**
 * Execução PASSO A PASSO no motor (migration 0714): concluir um bloco deixa a execução pausada (`paused_manual`, sem
 * horário) no seguinte; uma espera (`wait`) não é cumprida; e a execução comum não muda em nada.
 */
import { describe, expect, it, vi } from "vitest";

import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "./node-handlers";

const NOW = new Date("2026-11-05T12:00:00.000Z");

const GRAFO = {
  nodes: [
    { id: "t", type: "trigger", config: { kind: "manual" } },
    { id: "w", type: "wait", config: { mode: "fixed", duration_ms: 86_400_000 } },
    { id: "f", type: "end", config: { outcome: "converted" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "w", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "w", target: "f", priority: 0, condition: { type: "always" } },
  ],
} as unknown as FlowGraph;

function inscricao(atual: string, extra: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "c-1",
    conversation_id: null,
    current_node_id: atual,
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
    ...extra,
  };
}

function montar(eventos: EnrollmentEventRef[] = []) {
  const patches: Array<Record<string, unknown>> = [];
  const db = {
    assertServiceBoundary: vi.fn(async () => {}),
    loadFlowGraph: vi.fn(async () => GRAFO),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadEnrollmentEvents: vi.fn(async () => eventos),
    loadFlowPointerName: vi.fn(async () => "Fluxo"),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    updateEnrollment: vi.fn(async (_id: string, _org: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    }),
    insertDeadInboxItem: vi.fn(async () => {}),
  } as unknown as AdminClient;
  const deps = { db, clock: () => NOW, enqueueJob: vi.fn(async () => {}) } as unknown as TickDeps;
  return { deps, patches };
}

describe("motor — execução passo a passo", () => {
  it("concluir o gatilho avança para o bloco seguinte e PAUSA, sem horário", async () => {
    const { deps, patches } = montar();
    await avancarEnrollmentAtivo(deps, inscricao("t", { passo_a_passo: true }));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ current_node_id: "w", status: "paused_manual", next_eval_at: null });
  });

  it("a MESMA execução sem a marca avança e continua ativa com horário (nada mudou para o resto)", async () => {
    const { deps, patches } = montar();
    await avancarEnrollmentAtivo(deps, inscricao("t"));
    expect(patches[0]).toMatchObject({ current_node_id: "w", status: "active" });
    expect(typeof patches[0]!.next_eval_at).toBe("string");
  });

  it("bloco de espera: no passo a passo a espera NÃO é cumprida — conclui e pausa no seguinte", async () => {
    const { deps, patches } = montar();
    await avancarEnrollmentAtivo(deps, inscricao("w", { passo_a_passo: true }));
    expect(patches[0]).toMatchObject({ current_node_id: "f", status: "paused_manual", next_eval_at: null });
  });

  it("bloco de espera numa execução comum continua esperando de verdade", async () => {
    const { deps, patches } = montar();
    await avancarEnrollmentAtivo(deps, inscricao("w"));
    expect(patches[0]).toMatchObject({ current_node_id: "w", status: "active" });
    expect(Date.parse(patches[0]!.next_eval_at as string)).toBe(NOW.getTime() + 86_400_000);
  });

  it("o fim não vira pausa: o último bloco conclui a execução", async () => {
    const { deps, patches } = montar();
    await avancarEnrollmentAtivo(deps, inscricao("f", { passo_a_passo: true }));
    expect(patches[0]).toMatchObject({ status: "completed", next_eval_at: null });
  });
});
