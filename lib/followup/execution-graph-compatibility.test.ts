import { describe, expect, it } from "vitest";

import { flowGraphSchema, type FlowGraph } from "./graph-schema";
import { fromReactFlow, toReactFlow } from "./graph-mappers";
import { validateFlowForPublish } from "./validate-publish";

const legacy: FlowGraph = {
  nodes: [
    { id: "start", type: "trigger", label: "Início", config: {}, position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end",
      label: "Fim",
      config: { outcome: "exhausted" },
      position: { x: 0, y: 100 },
    },
  ],
  edges: [
    { id: "path", source: "start", target: "end", priority: 0, condition: { type: "always" } },
  ],
};

describe("compatibilidade de contrato do grafo", () => {
  it("não injeta marcador nem converte silenciosamente um fluxo legado", () => {
    expect(flowGraphSchema.parse(legacy)).toEqual(legacy);
    expect(Object.hasOwn(flowGraphSchema.parse(legacy), "execution_contract")).toBe(false);
    expect(validateFlowForPublish(legacy)).toEqual({ ok: true });
  });

  it("preserva contrato e configurações ao editar nós e arestas", () => {
    const graph: FlowGraph = {
      ...legacy,
      execution_contract: 1,
      settings: { somente_interno: true, max_tentativas_pergunta: 3 },
    };
    const { nodes, edges } = toReactFlow(graph);
    nodes[1]!.position = { x: 240, y: 300 };
    expect(
      fromReactFlow(nodes, edges, {
        execution_contract: graph.execution_contract,
        settings: graph.settings,
      }),
    ).toEqual({
      ...graph,
      nodes: [graph.nodes[0], { ...graph.nodes[1], position: { x: 240, y: 300 } }],
    });
  });

  it("recusa versões futuras; o contrato 1 não é mais barrado por indisponibilidade", () => {
    expect(flowGraphSchema.safeParse({ ...legacy, execution_contract: 2 }).success).toBe(false);
    const result = validateFlowForPublish({ ...legacy, execution_contract: 1 });
    if (!result.ok)
      expect(result.errors.map((error) => error.code)).not.toContain("execution_contract_unavailable");
  });

  describe("nós que o diário ainda não integra não entram no contrato 1", () => {
    const comNo = (node: FlowGraph["nodes"][number]): FlowGraph => ({
      execution_contract: 1,
      nodes: [legacy.nodes[0]!, node, legacy.nodes[1]!],
      edges: [
        { id: "a", source: "start", target: node.id, priority: 0, condition: { type: "always" } },
        { id: "b", source: node.id, target: "end", priority: 0, condition: { type: "always" } },
      ],
    });
    const codigos = (graph: FlowGraph) => {
      const r = validateFlowForPublish(graph);
      return r.ok ? [] : r.errors.map((e) => `${e.code}@${e.node_id}`);
    };

    it("recusa skill nomeando o nó; a espera smart passou a ser integrada (completePlan)", () => {
      const skill = {
        id: "n",
        type: "skill",
        label: "S",
        position: { x: 0, y: 50 },
        config: { skill_name: "qualquer" },
      } as FlowGraph["nodes"][number];
      const smart = {
        id: "n",
        type: "wait",
        label: "W",
        position: { x: 0, y: 50 },
        config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000 },
      } as FlowGraph["nodes"][number];
      expect(codigos(comNo(skill))).toContain("execution_node_not_integrated@n");
      expect(codigos(comNo(smart))).not.toContain("execution_node_not_integrated@n");
    });

    it("aceita ai_classify (integrado ao diário), e recusa só o que ainda não é", () => {
      const classify = {
        id: "n",
        type: "ai_classify",
        label: "C",
        position: { x: 0, y: 50 },
        config: { classes: ["quente"], grace_timeout_ms: 900_000, target: "last_reply" },
      } as FlowGraph["nodes"][number];
      expect(
        codigos(comNo(classify)).filter((c) => c.startsWith("execution_node_not_integrated")),
      ).toEqual([]);
    });

    it("aceita (quanto a este critério) os tipos integrados, e o legado nunca é afetado", () => {
      const tarefa = {
        id: "n",
        type: "internal_task",
        label: "T",
        position: { x: 0, y: 50 },
        config: { titulo: "x", vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "medium" },
      } as FlowGraph["nodes"][number];
      const fixa = {
        id: "n",
        type: "wait",
        label: "W",
        position: { x: 0, y: 50 },
        config: { mode: "fixed", duration_ms: 300_000 },
      } as FlowGraph["nodes"][number];
      expect(
        codigos(comNo(tarefa)).filter((c) => c.startsWith("execution_node_not_integrated")),
      ).toEqual([]);
      expect(
        codigos(comNo(fixa)).filter((c) => c.startsWith("execution_node_not_integrated")),
      ).toEqual([]);
      const legado: FlowGraph = { ...comNo(tarefa), execution_contract: undefined };
      delete (legado as { execution_contract?: unknown }).execution_contract;
      expect(codigos(legado).filter((c) => c.startsWith("execution_node_not_integrated"))).toEqual(
        [],
      );
    });
  });
});
