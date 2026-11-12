import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "./graph-schema";
import { simularCaminho } from "./simular-caminho";

const no = (id: string, type: string, config: unknown) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const aresta = (id: string, source: string, target: string, condition: unknown = { type: "always" }) => ({
  id,
  source,
  target,
  priority: 0,
  condition,
});

const grafo = flowGraphSchema.parse({
  nodes: [
    no("t", "trigger", {}),
    no("cond", "condition", {
      combinator: "and",
      branching: "per_check",
      checks: [{ id: "vip", label: "VIP", field: "tag", op: "eq", value: "vip" }],
    }),
    no("mapa", "map_data", { fields: [{ name: "saudacao", value: "Olá VIP", type: "text" }] }),
    no("msg", "action", { mode: "text", body: "{{nodes.mapa.fields.saudacao}}, tudo bem?" }),
    no("tag", "edit_lead_tag", { tags: ["frio"] }),
    no("f", "end", { outcome: "converted" }),
  ],
  edges: [
    aresta("e1", "t", "cond"),
    aresta("e2", "cond", "mapa", { type: "branch", branch_id: "vip" }),
    aresta("e3", "cond", "tag"),
    aresta("e4", "mapa", "msg"),
    aresta("e5", "msg", "f"),
    aresta("e6", "tag", "f"),
  ],
});

describe("simularCaminho — por onde iria, sem efeito real", () => {
  it("com a etiqueta VIP segue pelo ramo da regra, monta o campo e mostra a mensagem que sairia", () => {
    const p = simularCaminho(grafo, { fatos: { tags: ["vip"] } });
    expect(p.map((x) => x.no_id)).toEqual(["t", "cond", "mapa", "msg", "f"]);
    expect(p.find((x) => x.no_id === "cond")?.ramo).toBe("vip");
    expect(p.find((x) => x.no_id === "msg")?.texto).toBe("Olá VIP, tudo bem?");
    expect(p.find((x) => x.no_id === "msg")?.previsto).toMatch(/^faria:/);
  });

  it("sem a etiqueta vai pelo outro caminho (o avaliador é o mesmo do motor)", () => {
    expect(simularCaminho(grafo).map((x) => x.no_id)).toEqual(["t", "cond", "tag", "f"]);
  });

  it("Mapear dados sem valor para a simulação e diz por quê", () => {
    const quebrado = flowGraphSchema.parse({
      nodes: [no("t", "trigger", {}), no("mapa", "map_data", { fields: [{ name: "x", value: "{{nodes.t.nao_existe}}", type: "text" }] })],
      edges: [aresta("e1", "t", "mapa")],
    });
    const p = simularCaminho(quebrado);
    expect(p.at(-1)).toMatchObject({ no_id: "mapa", erro: expect.stringContaining("nao_existe") });
  });

  it("laço não trava a simulação (teto de passos)", () => {
    const laco = flowGraphSchema.parse({
      nodes: [no("t", "trigger", {}), no("w", "wait", { mode: "fixed", duration_ms: 600000 })],
      edges: [aresta("e1", "t", "w"), aresta("e2", "w", "w")],
    });
    expect(simularCaminho(laco).length).toBeLessThanOrEqual(50);
  });
});
