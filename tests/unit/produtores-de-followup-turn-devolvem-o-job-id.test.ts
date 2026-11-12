import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// No contrato 1 o motor liga a tentativa ao job logo após `enqueueJob`; produtor que não
// devolve o id derruba o tick DEPOIS de o job já estar na fila (revisão 19/10/2026).
// Todo `enqueueJob` de TickDeps (insert em job_queue kind followup_turn) devolve { job_id }.
const PRODUTORES = [
  "app/api/v1/cron/followup-flow-worker/route.ts",
  "lib/followup/aplicar-inbound.ts",
  "lib/relogio/executar.ts",
  "lib/dev/kick-local-pipeline.ts",
];

describe("produtores de followup_turn devolvem o job_id", () => {
  it.each(PRODUTORES)("%s lê o id inserido e o devolve", (arquivo) => {
    const fonte = readFileSync(arquivo, "utf8");
    expect(fonte).toContain('kind: "followup_turn"');
    expect(fonte).toMatch(/\.select\("id"\)\s*\.single\(\)/);
    expect(fonte).toContain("return { job_id: data.id }");
  });

  it("nenhum outro arquivo de lib/app/scripts cria job followup_turn por insert direto", () => {
    // Se aparecer um produtor novo, ele precisa entrar na lista acima.
    const achados = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-E",
        '(^|[^_a-z])kind: "followup_turn"',
        "--",
        "lib",
        "app",
        "scripts",
        "workers",
        ":!*.test.ts",
        ":!*.test.tsx",
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(achados).toEqual([...PRODUTORES].sort());
  });
});
