import { describe, expect, it } from "vitest";

import { passosDosEventos, type EventoParaCaminho } from "./passos-dos-eventos";

const nos = new Map([
  ["t", { rotulo: "Início", tipo: "trigger" as const }],
  ["m", { rotulo: "Mensagem", tipo: "action" as const }],
  ["f", { rotulo: "Fim", tipo: "end" as const }],
]);
let n = 0;
const ev = (event_type: string, node_id: string | null, minuto: number, payload: Record<string, unknown> = {}): EventoParaCaminho => ({
  id: `e${++n}`,
  node_id,
  event_type,
  payload,
  created_at: new Date(Date.UTC(2026, 10, 5, 10, minuto)).toISOString(),
});

describe("passosDosEventos", () => {
  it("execução concluída: um passo por bloco, em ordem, com a duração desde que o bloco foi alcançado até ele avançar", () => {
    const r = passosDosEventos(
      [
        ev("node_advanced", "t", 0, { next_node_id: "m" }),
        ev("turn_enqueued", "m", 1),
        ev("action_sent", "m", 2),
        ev("node_advanced", "m", 3, { next_node_id: "f" }),
        ev("flow_completed", "f", 3),
      ],
      nos,
      { status: "completed", currentNodeId: "f" },
    );
    expect(r.map((p) => [p.node_id, p.status])).toEqual([["t", "succeeded"], ["m", "succeeded"], ["f", "succeeded"]]);
    expect(r[1]).toMatchObject({ rotulo: "Mensagem", tentativas: 1, duracao_ms: 3 * 60_000 });
    expect(r[1]).not.toHaveProperty("entrada");
  });

  it("morta no envio: o bloco atual falha com a causa, sem o prefixo técnico", () => {
    const r = passosDosEventos(
      [
        ev("node_advanced", "t", 0, { next_node_id: "m" }),
        ev("turn_enqueued", "m", 1),
        ev("flow_dead", "m", 5, { reason: "action_turn_failed: canal fora" }),
      ],
      nos,
      { status: "dead", currentNodeId: "m" },
    );
    expect(r.at(-1)).toMatchObject({ node_id: "m", status: "failed", erro: "canal fora" });
    expect(r.map((p) => p.node_id)).toEqual(["t", "m"]);
  });

  it("viva: o bloco que o motor ainda trabalha fica 'em andamento'", () => {
    const r = passosDosEventos([ev("node_advanced", "t", 0, { next_node_id: "m" })], nos, {
      status: "active",
      currentNodeId: "m",
    });
    expect(r.map((p) => [p.node_id, p.status])).toEqual([["t", "succeeded"], ["m", "running"]]);
  });

  it("laço: voltar ao mesmo bloco abre uma nova visita", () => {
    const r = passosDosEventos(
      [
        ev("node_advanced", "m", 0, { next_node_id: "t" }),
        ev("node_advanced", "t", 1, { next_node_id: "m" }),
        ev("node_advanced", "m", 2, { next_node_id: "f" }),
      ],
      nos,
      { status: "active", currentNodeId: "f" },
    );
    expect(r.filter((p) => p.node_id === "m").map((p) => p.visit)).toEqual([0, 1]);
  });

  it("saída de erro: o bloco falha e o fluxo segue para o destino", () => {
    const r = passosDosEventos(
      [ev("execution_error_routed", "m", 1, { next_node_id: "f", code: "canal_fora" })],
      nos,
      { status: "active", currentNodeId: "f" },
    );
    expect(r.map((p) => [p.node_id, p.status])).toEqual([["m", "failed"], ["f", "running"]]);
    expect(r[0]!.erro).toBe("canal_fora");
  });

  it("cancelada: o que estava aberto vira 'pulado', não 'concluído'", () => {
    const r = passosDosEventos([ev("node_advanced", "t", 0, { next_node_id: "m" })], nos, {
      status: "cancelled",
      currentNodeId: "m",
    });
    expect(r.at(-1)).toMatchObject({ node_id: "m", status: "skipped" });
  });

  it("evento sem bloco é ignorado; lista vazia dá caminho vazio, nada inventado", () => {
    expect(passosDosEventos([ev("cancelled_manual", null, 0)], nos, { status: "cancelled", currentNodeId: null })).toEqual([]);
    expect(passosDosEventos([], nos, { status: "active", currentNodeId: "t" })).toEqual([]);
  });

  it("nó que saiu do grafo aparece pelo id", () => {
    const r = passosDosEventos([ev("node_advanced", "fantasma", 0)], nos, { status: "active", currentNodeId: null });
    expect(r[0]).toMatchObject({ rotulo: "fantasma", tipo: null });
  });
});
