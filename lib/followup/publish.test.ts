import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { FlowGraph } from "./graph-schema";
import { comContratoDeExecucao, publishFollowupFlowVersion } from "./publish";

const graph = { nodes: [], edges: [] } as unknown as FlowGraph;
const params = { orgId: "org", pointerId: "ptr", graph, createdBy: "user" };
const admin = (reply: { data?: unknown; error?: { message: string } | null }) =>
  ({
    rpc: async () => ({ data: reply.data ?? null, error: reply.error ?? null }),
  }) as unknown as SupabaseClient;

describe("publishFollowupFlowVersion: tradução das recusas do banco", () => {
  it("devolve a versão criada", async () => {
    await expect(publishFollowupFlowVersion(admin({ data: "v-1" }), params)).resolves.toEqual({
      ok: true,
      version_id: "v-1",
    });
  });

  it("ponteiro inexistente vira pointer_not_found", async () => {
    await expect(
      publishFollowupFlowVersion(admin({ error: { message: "pointer_not_found" } }), params),
    ).resolves.toMatchObject({ ok: false, code: "pointer_not_found" });
  });

  it("a guarda do contrato novo (0707) vira execution_contract_unavailable, não erro interno", async () => {
    await expect(
      publishFollowupFlowVersion(
        admin({ error: { message: "execution_contract_unavailable" } }),
        params,
      ),
    ).resolves.toMatchObject({ ok: false, code: "execution_contract_unavailable" });
  });

  it("qualquer outro erro do banco continua sendo internal_error", async () => {
    await expect(
      publishFollowupFlowVersion(admin({ error: { message: "boom" } }), params),
    ).resolves.toMatchObject({ ok: false, code: "internal_error", message: "boom" });
  });

  it("resposta sem id de versão é internal_error", async () => {
    await expect(publishFollowupFlowVersion(admin({ data: 42 }), params)).resolves.toMatchObject({
      ok: false,
      code: "internal_error",
    });
  });
});

describe("comContratoDeExecucao (motor único)", () => {
  it.each(["followup", "crm_automation"])("fluxo do relógio (%s) é publicado no contrato 1", (surface) => {
    expect(comContratoDeExecucao(graph, surface).execution_contract).toBe(1);
  });

  it("roteiro de atendimento não ganha a chave e o grafo original não é alterado", () => {
    expect(comContratoDeExecucao(graph, "atendimento")).toBe(graph);
    expect(graph.execution_contract).toBeUndefined();
  });
});
