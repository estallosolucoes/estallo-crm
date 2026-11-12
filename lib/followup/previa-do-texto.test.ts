import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "./graph-schema";
import { previaDoTexto } from "./previa-do-texto";

const no = (id: string, type: string, config: unknown) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const g = flowGraphSchema.parse({
  nodes: [
    no("t", "trigger", {}),
    no("c", "condition", { combinator: "and", branching: "per_check", checks: [{ id: "a", field: "tag", op: "eq", value: "x" }] }),
    no("m", "action", { mode: "text", body: "x" }),
  ],
  edges: [
    { id: "e1", source: "t", target: "c", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "c", target: "m", priority: 0, condition: { type: "always" } },
  ],
});

describe("previaDoTexto", () => {
  it("preenche contato e saída de bloco anterior com a amostra", () => {
    const r = previaDoTexto("Oi {{primeiro_nome}}, caminho {{nodes.c.branch_id}}", g, "m");
    expect(r).toEqual({ texto: "Oi Maria, caminho sim", sem_valor: [] });
  });
  it("variável sem valor some com o espaço vizinho e é listada, nunca sai crua", () => {
    const r = previaDoTexto("Olá {{apelido}}, tudo?", g, "m");
    expect(r.texto).toBe("Olá, tudo?");
    expect(r.sem_valor).toEqual(["{{apelido}}"]);
  });
  it("bloco que não vem antes não tem amostra: fica sem valor", () => {
    const r = previaDoTexto("Id {{nodes.m.task_id}}", g, "c");
    expect(r.sem_valor).toEqual(["{{nodes.m.task_id}}"]);
    expect(r.texto).toBe("Id");
  });
  it("sem variável, o texto não muda", () => {
    expect(previaDoTexto("Oi!", null, null)).toEqual({ texto: "Oi!", sem_valor: [] });
  });
});
