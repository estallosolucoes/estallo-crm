import { describe, expect, it } from "vitest";

import { projetarCaminho } from "./caminho-no-grafo";
import type { PassoDaExecucao } from "./passos-da-execucao";

const passo = (node_id: string, extra: Partial<PassoDaExecucao> = {}): PassoDaExecucao => ({
  step_id: `s-${node_id}`, node_id, rotulo: node_id, tipo: null, status: "succeeded", branch_id: null, visit: 0,
  entered_at: "2026-11-03T20:00:00Z", completed_at: null, duracao_ms: null, tentativas: 1, erro: null, ...extra,
});
const arestas = [
  { id: "e1", source: "t", target: "c", condition: { type: "always" } },
  { id: "e2", source: "c", target: "m1", condition: { type: "branch", branch_id: "vca" } },
  { id: "e3", source: "c", target: "m1", condition: { type: "always" } },
  { id: "e4", source: "c", target: "m2", condition: { type: "branch", branch_id: "micro" } },
];

describe("projetarCaminho", () => {
  it("pinta os blocos visitados com o estado e só as ligações atravessadas, na saída que o passo registrou", () => {
    const r = projetarCaminho([passo("t"), passo("c", { branch_id: "vca" }), passo("m1", { status: "failed" })], arestas);
    expect(r.estadoDoNo.get("m1")).toBe("failed");
    expect(r.estadoDoNo.has("m2")).toBe(false);
    expect([...r.arestasPercorridas].sort()).toEqual(["e1", "e2"]); // e3 (sempre) liga os mesmos blocos mas NÃO foi a saída tomada
  });

  it("saída 'else' ou ausente usa a ligação 'sempre'", () => {
    const r = projetarCaminho([passo("c", { branch_id: "else" }), passo("m1")], arestas);
    expect([...r.arestasPercorridas]).toEqual(["e3"]);
  });

  it("sem como decidir entre várias ligações, não afirma nenhuma", () => {
    const r = projetarCaminho([passo("c", { branch_id: "outra" }), passo("m1")], arestas);
    expect(r.arestasPercorridas.size).toBe(0);
  });

  it("num laço, o estado do bloco é o da visita mais recente", () => {
    const r = projetarCaminho([passo("t", { status: "failed" }), passo("t", { status: "succeeded", visit: 1 })], arestas);
    expect(r.estadoDoNo.get("t")).toBe("succeeded");
  });
});
