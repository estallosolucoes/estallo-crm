import { describe, expect, it } from "vitest";

import { pausaDepoisDoBloco } from "./passo-a-passo";

const passo = { passo_a_passo: true, current_node_id: "a" };

describe("pausaDepoisDoBloco", () => {
  it("passo a passo: ao mudar de bloco, pausa sem horário", () => {
    expect(
      pausaDepoisDoBloco(passo, { current_node_id: "b", status: "active", next_eval_at: "2026-11-05T10:00:00Z" }),
    ).toMatchObject({ current_node_id: "b", status: "paused_manual", next_eval_at: null });
  });

  it("preserva o resto do patch (passos, lease, relógio de atualização)", () => {
    const r = pausaDepoisDoBloco(passo, {
      current_node_id: "b",
      status: "active",
      next_eval_at: "x",
      steps_taken: 4,
      claimed_until: null,
    });
    expect(r).toMatchObject({ steps_taken: 4, claimed_until: null });
  });

  it("sem mudar de bloco (espera, recheck, nova tentativa): o bloco ainda está sendo cumprido, nada muda", () => {
    const patch = { current_node_id: "a", status: "active" as const, next_eval_at: "2026-11-05T10:00:00Z" };
    expect(pausaDepoisDoBloco(passo, patch)).toBe(patch);
    const sem = { status: "waiting_reply" as const, next_eval_at: "2026-11-05T10:00:00Z" };
    expect(pausaDepoisDoBloco(passo, sem)).toBe(sem);
  });

  it("estado final (concluída, cancelada, morta) não vira pausa", () => {
    const fim = { current_node_id: "b", status: "completed" as const, completed_at: "x" };
    expect(pausaDepoisDoBloco(passo, fim)).toBe(fim);
  });

  it("execução comum (sem a marca) nunca é tocada", () => {
    const patch = { current_node_id: "b", status: "active" as const, next_eval_at: "x" };
    expect(pausaDepoisDoBloco({ current_node_id: "a" }, patch)).toBe(patch);
    expect(pausaDepoisDoBloco({ passo_a_passo: false, current_node_id: "a" }, patch)).toBe(patch);
  });
});
