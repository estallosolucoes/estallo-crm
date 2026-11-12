import { afterEach, describe, expect, it, vi } from "vitest";

import { runFollowupTick, type TickDeps } from "./engine";

/** Só o `claimDueEnrollments` importa aqui: sem inscrição vencida, nada mais é tocado. */
function deps(claim: () => Promise<unknown[]>): { deps: TickDeps; claims: () => number } {
  let n = 0;
  const db = {
    claimDueEnrollments: async () => {
      n += 1;
      return claim();
    },
  };
  return { deps: { db, clock: () => new Date(), enqueueJob: vi.fn() } as unknown as TickDeps, claims: () => n };
}

afterEach(() => vi.useRealTimers());

describe("runFollowupTick — encadeado", () => {
  it("sem `encadearMs`: UMA passada, como sempre", async () => {
    const d = deps(async () => []);
    await runFollowupTick(d.deps);
    expect(d.claims()).toBe(1);
  });

  it("com `encadearMs`: repete as conferências até o tempo acabar, para o fluxo correr em segundos", async () => {
    vi.useFakeTimers();
    const d = deps(async () => []);
    const sleep = async (ms: number) => {
      vi.advanceTimersByTime(ms);
    };
    await runFollowupTick(d.deps, { encadearMs: 5_000, sleep });
    // ocioso: confere a cada 1,5 s dentro de 5 s
    expect(d.claims()).toBeGreaterThanOrEqual(3);
    expect(d.claims()).toBeLessThanOrEqual(4);
  });

  it("claim que falha encerra o encadeamento — não martela o banco fora do ar", async () => {
    vi.useFakeTimers();
    const d = deps(async () => {
      throw new Error("db fora");
    });
    const sleep = async (ms: number) => {
      vi.advanceTimersByTime(ms);
    };
    const r = await runFollowupTick(d.deps, { encadearMs: 5_000, sleep });
    expect(d.claims()).toBe(1);
    expect(r.claim_falhou).toBe(true);
  });
});
