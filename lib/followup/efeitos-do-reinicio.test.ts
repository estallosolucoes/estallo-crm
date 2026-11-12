import { describe, expect, it } from "vitest";

import { blocosComEfeito } from "./efeitos-do-reinicio";

const nos = [
  { id: "t", rotulo: "Início", tipo: "trigger" },
  { id: "c", rotulo: "Produto?", tipo: "condition" },
  { id: "m1", rotulo: "Mensagem 1", tipo: "action" },
  { id: "m2", rotulo: "Mensagem 2", tipo: "action" },
  { id: "k", rotulo: "Tarefa", tipo: "internal_task" },
  { id: "f", rotulo: "Fim", tipo: "end" },
];

describe("blocosComEfeito", () => {
  it("só os blocos que agem entram; gatilho, condição e fim não", () => {
    expect(blocosComEfeito(nos, []).map((b) => b.id).sort()).toEqual(["k", "m1", "m2"]);
  });
  it("marca o que a original já fez (concluído ou falhado) e põe esses primeiro (a ordem do fluxo se mantém entre iguais)", () => {
    const r = blocosComEfeito(nos, [
      { node_id: "m2", status: "succeeded" },
      { node_id: "k", status: "failed" },
      { node_id: "m1", status: "skipped" },
    ]);
    expect(r.map((b) => [b.id, b.jaAconteceu])).toEqual([
      ["m2", true],
      ["k", true],
      ["m1", false],
    ]);
  });
  it("sem blocos de efeito, lista vazia", () => {
    expect(blocosComEfeito(nos.filter((n) => n.tipo === "end"), [])).toEqual([]);
  });
});
