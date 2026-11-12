import { describe, expect, it, vi } from "vitest";

import { flowGraphSchema } from "./graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";
import { NODE_OUTPUT_CONTRACTS } from "./node-output-contracts";

const NOW = new Date("2026-10-19T01:00:00Z");
const enrollment = {
  id: "run",
  organization_id: "org",
  contact_id: "contact",
  lead_id: "lead",
  conversation_id: null,
  execution_contract: 1,
  current_node_id: "condition",
  steps_taken: 0,
} as EnrollmentRow;
const facts: LeadFacts = { lead_stage: null, tags: ["vip"], steps_taken: 0, last_outcome: null };

function graph(perCheck = false, fallbackOnly = false) {
  return flowGraphSchema.parse({
    execution_contract: 1,
    nodes: [
      {
        id: "condition",
        type: "condition",
        label: "Condição",
        position: { x: 0, y: 0 },
        config: {
          combinator: "and",
          ...(perCheck ? { branching: "per_check" } : {}),
          checks: [
            { id: "rule-one", field: "tag", op: "contains", value: "vip" },
            { id: "rule-two", field: "steps_taken", op: "gte", value: 0 },
          ],
        },
      },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
    ],
    edges: fallbackOnly
      ? [{ id: "escape", source: "condition", target: "end", condition: { type: "always" } }]
      : perCheck
        ? [
            {
              id: "first-edge",
              source: "condition",
              target: "end",
              condition: { type: "branch", branch_id: "rule-one" },
            },
            {
              id: "second-edge",
              source: "condition",
              target: "end",
              condition: { type: "branch", branch_id: "rule-two" },
            },
          ]
        : [
            {
              id: "true-edge",
              source: "condition",
              target: "end",
              condition: { type: "cond_result", value: true },
            },
            {
              id: "false-edge",
              source: "condition",
              target: "end",
              condition: { type: "cond_result", value: false },
            },
          ],
  });
}

describe("evidência da decisão produzida pelo handler puro", () => {
  it.each([
    [true, "true-edge", "true"],
    [false, "false-edge", "false"],
  ] as const)(
    "condição %s distingue arestas mesmo quando ambas levam ao mesmo nó",
    (matched, edgeId, branchId) => {
      const g = graph(),
        trace = vi.fn();
      const result = processNode({
        node: g.nodes[0]!,
        edges: g.edges,
        enrollment,
        lead: { ...facts, tags: matched ? ["vip"] : [] },
        clock: () => NOW,
        onDecision: trace,
      });
      expect(result).toMatchObject({ kind: "advance", next_node_id: "end" });
      expect(trace).toHaveBeenCalledOnce();
      const observed = trace.mock.calls[0]![0];
      expect(observed).toMatchObject({
        edge_id: edgeId,
        branch_id: branchId,
        output: {
          matched,
          branch_id: branchId,
          checks: [
            { index: 0, matched },
            { index: 1, matched: true },
          ],
        },
      });
      expect(NODE_OUTPUT_CONTRACTS.condition.safeParse(observed.output).success).toBe(true);
    },
  );

  it("uma saída por regra registra só as regras avaliadas até a primeira correspondência", () => {
    const g = graph(true),
      trace = vi.fn();
    processNode({
      node: g.nodes[0]!,
      edges: g.edges,
      enrollment,
      lead: facts,
      clock: () => NOW,
      onDecision: trace,
    });
    expect(trace).toHaveBeenCalledWith({
      edge_id: "first-edge",
      branch_id: "rule-one",
      output: { matched: true, branch_id: "rule-one", checks: [{ index: 0, matched: true }] },
    });
  });

  it("regra verdadeira sem conexão registra a saída de escape efetivamente percorrida", () => {
    const g = graph(true, true),
      trace = vi.fn();
    processNode({
      node: g.nodes[0]!,
      edges: g.edges,
      enrollment,
      lead: facts,
      clock: () => NOW,
      onDecision: trace,
    });
    expect(trace).toHaveBeenCalledWith({
      edge_id: "escape",
      branch_id: "else",
      output: { matched: true, branch_id: "else", checks: [{ index: 0, matched: true }] },
    });
  });

  it("sem aresta não inventa decisão concluída", () => {
    const g = graph(),
      trace = vi.fn();
    expect(
      processNode({
        node: g.nodes[0]!,
        edges: [],
        enrollment,
        lead: facts,
        clock: () => NOW,
        onDecision: trace,
      }),
    ).toMatchObject({ kind: "fail" });
    expect(trace).not.toHaveBeenCalled();
  });

  it("instrumentar a decisão conserva a forma do resultado legado", () => {
    const g = graph(),
      input = { node: g.nodes[0]!, edges: g.edges, enrollment, lead: facts, clock: () => NOW };
    expect(processNode({ ...input, onDecision: vi.fn() })).toEqual(processNode(input));
  });
});
