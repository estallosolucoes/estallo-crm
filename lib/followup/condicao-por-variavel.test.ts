import { describe, expect, it } from "vitest";

import { flowGraphSchema, type FlowEdge, type FlowNode } from "./graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";
import { validateFlowForPublish } from "./validate-publish";

/**
 * Condição ampliada (Fase 5): uma regra lê a saída de um bloco ANTERIOR (`field: "variavel"`) com o MESMO avaliador
 * das outras regras, e «tem valor / não tem valor» distingue ausente, nulo, texto vazio e lista vazia.
 */
const NOW = new Date("2026-11-11T12:00:00Z");
const enrollment = { id: "e", organization_id: "o", contact_id: "c", current_node_id: "cond", steps_taken: 0 } as unknown as EnrollmentRow;
const lead: LeadFacts = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };
const edges: FlowEdge[] = [
  { id: "a", source: "cond", target: "sim", priority: 0, condition: { type: "branch", branch_id: "r1" } },
  { id: "b", source: "cond", target: "nao", priority: 0, condition: { type: "always" } },
];

function decide(check: Record<string, unknown>, saidas: Record<string, unknown>) {
  const node = {
    id: "cond",
    type: "condition",
    label: "c",
    position: { x: 0, y: 0 },
    config: { combinator: "and", branching: "per_check", checks: [{ id: "r1", field: "variavel", value: "", ...check }] },
  } as unknown as FlowNode;
  const r = processNode({ node, edges, enrollment, lead, clock: () => NOW, saidasAnteriores: saidas });
  return r.kind === "advance" ? r.next_node_id : r.kind;
}

const SAIDAS = { mapa: { fields: { total: 1500, nome: "Ana", vazio: "", lista: [], nulo: null, cores: ["Azul", "verde"] } } };

describe("condição sobre o dado de um bloco anterior", () => {
  it("compara texto sem diferença de caixa, número por valor e lista por pertinência", () => {
    expect(decide({ source: "{{nodes.mapa.fields.nome}}", op: "eq", value: "ana" }, SAIDAS)).toBe("sim");
    expect(decide({ source: "{{nodes.mapa.fields.total}}", op: "gte", value: "1000" }, SAIDAS)).toBe("sim");
    expect(decide({ source: "{{nodes.mapa.fields.total}}", op: "lte", value: "1000" }, SAIDAS)).toBe("nao");
    expect(decide({ source: "{{nodes.mapa.fields.cores}}", op: "contains", value: "azul" }, SAIDAS)).toBe("sim");
  });

  it("tem valor: ausente, nulo, texto vazio e lista vazia NÃO têm; o resto tem", () => {
    for (const campo of ["nao_existe", "nulo", "vazio", "lista"])
      expect(decide({ source: `{{nodes.mapa.fields.${campo}}}`, op: "exists" }, SAIDAS), campo).toBe("nao");
    expect(decide({ source: "{{nodes.mapa.fields.nome}}", op: "exists" }, SAIDAS)).toBe("sim");
    expect(decide({ source: "{{nodes.mapa.fields.nulo}}", op: "not_exists" }, SAIDAS)).toBe("sim");
  });

  it("ausência não prova a negação: «é diferente de» sobre dado ausente é falso", () => {
    expect(decide({ source: "{{nodes.mapa.fields.nao_existe}}", op: "neq", value: "x" }, SAIDAS)).toBe("nao");
  });

  it("publicação: exige o dado escolhido, valida que o bloco vem antes, e «tem valor» dispensa valor", () => {
    const grafo = (check: Record<string, unknown>) =>
      flowGraphSchema.parse({
        nodes: [
          { id: "t", type: "trigger", label: "t", position: { x: 0, y: 0 }, config: {} },
          { id: "mapa", type: "map_data", label: "m", position: { x: 0, y: 0 }, config: { fields: [{ name: "total", value: "1", type: "number" }] } },
          {
            id: "cond",
            type: "condition",
            label: "c",
            position: { x: 0, y: 0 },
            config: { combinator: "and", branching: "per_check", checks: [{ id: "r1", field: "variavel", value: "", ...check }] },
          },
          { id: "f", type: "end", label: "f", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
        ],
        edges: [
          { id: "e1", source: "t", target: "mapa", priority: 0, condition: { type: "always" } },
          { id: "e2", source: "mapa", target: "cond", priority: 0, condition: { type: "always" } },
          { id: "e3", source: "cond", target: "f", priority: 0, condition: { type: "branch", branch_id: "r1" } },
          { id: "e4", source: "cond", target: "f", priority: 0, condition: { type: "always" } },
        ],
      });
    expect(validateFlowForPublish(grafo({ source: "{{nodes.mapa.fields.total}}", op: "exists" }), {})).toEqual({ ok: true });
    expect(validateFlowForPublish(grafo({ op: "exists" }), {})).toMatchObject({ ok: false, errors: [{ code: "empty_check_value" }] });
    expect(validateFlowForPublish(grafo({ source: "{{nodes.mapa.fields.outro}}", op: "exists" }), {})).toMatchObject({
      ok: false,
      errors: [{ code: "variavel_de_bloco_campo_inexistente" }],
    });
    expect(validateFlowForPublish(grafo({ source: "{{nodes.mapa.fields.total}}", op: "eq", value: "" }), {})).toMatchObject({
      ok: false,
      errors: [{ code: "empty_check_value" }],
    });
  });
});
