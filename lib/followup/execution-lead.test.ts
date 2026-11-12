import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  executionLeadTarget,
  ExecutionLeadUnavailableError,
  loadLeadForExecution,
} from "./execution-lead";

const ROWS = [
  {
    id: "original",
    organization_id: "a",
    contact_id: "contato",
    pipeline_id: "p1",
    updated_at: "2026-10-01",
  },
  {
    id: "recente",
    organization_id: "a",
    contact_id: "contato",
    pipeline_id: "p2",
    updated_at: "2026-10-02",
  },
  {
    id: "vizinho",
    organization_id: "b",
    contact_id: "contato-b",
    pipeline_id: "p1",
    updated_at: "2026-10-03",
  },
];

function fixture() {
  let reads = 0;
  const admin = {
    from(table: string) {
      expect(table).toBe("crm_leads");
      reads++;
      let rows = [...ROWS];
      const query = {
        select: () => query,
        eq: (key: keyof (typeof ROWS)[number], value: string) => {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        order: () => {
          rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          return query;
        },
        limit: (count: number) => {
          rows = rows.slice(0, count);
          return query;
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { admin, reads: () => reads };
}

describe("alvo explícito do lead da execução", () => {
  it("mantém o lead original mesmo se outro negócio for mais recente ou estiver no funil de destino", async () => {
    const { admin } = fixture();
    const target = executionLeadTarget({ execution_contract: 1, lead_id: "original" });
    expect(await loadLeadForExecution(admin, "a", "contato", "*", target, "p2")).toMatchObject({
      id: "original",
    });
  });

  it("ausência explícita de lead não consulta nem escolhe negócio pelo contato", async () => {
    const f = fixture();
    expect(
      await loadLeadForExecution(
        f.admin,
        "a",
        "contato",
        "*",
        executionLeadTarget({ execution_contract: 1, lead_id: null }),
      ),
    ).toBeNull();
    expect(f.reads()).toBe(0);
  });

  it.each([
    ["a", "outro-contato", "original"],
    ["a", "contato-b", "vizinho"],
    ["a", "contato", "apagado"],
  ])(
    "recusa alvo indisponível ou fora do contexto (%s/%s/%s), sem fallback",
    async (org, contact, lead) => {
      const { admin } = fixture();
      await expect(
        loadLeadForExecution(admin, org, contact, "*", { execution_contract: 1, lead_id: lead }),
      ).rejects.toBeInstanceOf(ExecutionLeadUnavailableError);
    },
  );

  it("preserva a seleção antiga somente em execuções legadas", async () => {
    const { admin } = fixture();
    expect(executionLeadTarget({})).toBeUndefined();
    expect(await loadLeadForExecution(admin, "a", "contato", "*")).toMatchObject({ id: "recente" });
    expect(await loadLeadForExecution(admin, "a", "contato", "*", undefined, "p1")).toMatchObject({
      id: "original",
    });
  });
});
