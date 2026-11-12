import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * A aba Execuções do editor atualiza ao vivo só se `followup_enrollments` está na publicação (migration 0715).
 * Os diários ficam fora: todo passo já move a linha da execução, e publicá-los dobraria o volume sem dado novo.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function publicadas(): string[] {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c",
      "select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by 1"],
    { encoding: "utf8" },
  ).trim().split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("execuções do fluxo na publicação de realtime", () => {
  it("a sonda enxerga a publicação (guarda de vacuidade)", () => {
    expect(publicadas().length).toBeGreaterThan(5);
  });

  it("followup_enrollments PUBLICA — a aba Execuções acompanha a execução andando", () => {
    expect(publicadas()).toContain("followup_enrollments");
  });

  it("os diários NÃO publicam — o passo já move a execução", () => {
    expect(publicadas()).not.toContain("followup_execution_steps");
    expect(publicadas()).not.toContain("followup_execution_attempts");
  });
});
