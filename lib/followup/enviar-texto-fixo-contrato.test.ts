import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { enviarTextoFixoPendente } from "./enviar-texto-fixo";

const mocks = vi.hoisted(() => ({
  loadFlowGraph: vi.fn(),
  sendMessage: vi.fn(async () => ({ id: "message" })),
  complete: vi.fn(async () => {}),
}));
vi.mock("./engine", () => ({
  createSupabaseAdminClient: () => ({ loadFlowGraph: mocks.loadFlowGraph }),
}));
vi.mock("./turn-bridge", () => ({ completeTurnForEnrollment: mocks.complete }));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(async () => {}),
}));
vi.mock("@/lib/agenda/efeito", () => ({ assertAgendaEffectSupabase: vi.fn(async () => {}) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => null),
}));
vi.mock("./janela-de-disparo", () => ({ decidirAdiamentoPorJanela: vi.fn(async () => null) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.sendMessage }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  supabaseSendLedger: () => ({}),
  sendWithLedger: async (
    _ledger: unknown,
    _input: unknown,
    send: (key: string, id: string) => Promise<unknown>,
  ) => {
    await send("key", "message");
    return { kind: "sent" };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";

function fixture(contract: number, graphContract?: 1) {
  mocks.loadFlowGraph.mockResolvedValue({
    ...(graphContract ? { execution_contract: graphContract } : {}),
  });
  const settles: Array<Record<string, unknown>> = [];
  const db = {
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      settles.push(args);
      return { data: true, error: null };
    }),
    from(table: string) {
      let mutation = false;
      const query = {
        select: () => query,
        eq: () => query,
        lt: () => query,
        order: () => query,
        update: () => {
          mutation = true;
          return query;
        },
        limit: async () => ({
          data: [
            {
              id: "job",
              organization_id: ORG,
              contact_id: CONTACT,
              attempts: 0,
              payload: {
                fixed_body: "Olá",
                followup_enrollment_id: "run",
                node_id: "action",
                service_boundary: {
                  organization_id: ORG,
                  contact_id: CONTACT,
                  conversation_id: CONVERSATION,
                  service_revision: 1,
                  demanda_id: null,
                  demanda_revision: null,
                },
              },
            },
          ],
          error: null,
        }),
        maybeSingle: async () => ({
          data:
            table === "followup_enrollments"
              ? {
                  current_node_id: "action",
                  status: "active",
                  revision: 1,
                  version_id: "version",
                  execution_contract: contract,
                }
              : mutation
                ? { id: "job", locked_by: "worker", locked_at: "2026-10-18T18:00:00Z" }
                : null,
          error: null,
        }),
      };
      return query;
    },
  };
  return { admin: db as unknown as SupabaseClient, settles };
}

beforeEach(() => vi.clearAllMocks());

describe("envio inline verifica contrato antes do efeito", () => {
  it.each([
    [0, 1, "execution_contract_mismatch"],
    [1, undefined, "execution_contract_mismatch"],
  ] as const)("contratos %s/%s não enviam (%s)", async (contract, graph, reason) => {
    const f = fixture(contract, graph);
    expect(await enviarTextoFixoPendente(f.admin)).toBe(0);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(f.settles).toEqual([expect.objectContaining({ p_done: false, p_error: reason })]);
  });

  it("controle: contrato legado envia e conclui pelo caminho existente", async () => {
    const f = fixture(0);
    expect(await enviarTextoFixoPendente(f.admin)).toBe(1);
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(f.settles).toEqual([expect.objectContaining({ p_done: true })]);
  });
});
