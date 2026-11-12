/**
 * `handoff_policy='allow'` TEM DE VALER NO ENVIO, não só na reatividade.
 *
 * Medido em produção (03/11/2026, Prática Biomed): o fluxo "Indicação Pós-Venda" tinha a política
 * `allow`, o contato estava com a conversa ASSUMIDA por uma pessoa da equipe (silêncio da IA sem fim) e o
 * envio fixo era recusado ("O envio foi recusado pelas regras do atendimento") — `sendFixedOutbound`
 * perguntava `isLeadInHandoff` antes de tudo, sem olhar a política do fluxo. Quem move o card é a própria
 * equipe, então "assumida por uma pessoa" é o caso normal, e a política existe justamente para isso.
 *
 * Os dois lados ficam guardados: `allow` envia; `pause` (o padrão) continua recusando.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runBeforeSend = vi.fn(async (_args: Record<string, unknown>) => ({
  status: "sent",
  outcome: { kind: "sent" },
  trace: [],
}));
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));

// A conversa está assumida por uma pessoa.
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  isLeadInHandoff: vi.fn(async () => true),
}));

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({
  applySendOutcome: vi.fn(async () => undefined),
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: { ...payload, service_boundary: boundary }, status: "running", priority: 0, run_after: new Date(),
    attempts: 1, max_attempts: 3, last_error: null, locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

function fakePool(politica: "allow" | "pause") {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (sql.includes("p.handoff_policy from followup_enrollments")) return { rows: [{ handoff_policy: politica }] };
    if (/from org_guardrail_layers/.test(sql)) return { rows: [] };
    if (/from conversations/.test(sql)) return { rows: [{ id: CONVERSA, channel_session_id: "canal-1", archived_at: null }] };
    if (sql.includes("select e.current_node_id, e.status, e.execution_contract")) {
      return { rows: [{ current_node_id: "node-1", status: "active" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never };
}

const completeFollowupTurn = vi.fn(async (..._a: unknown[]) => undefined);
function deps() {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {}, llmCfg: {}, knobs: { promiseSemantic: { enabled: false } },
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn,
  } as never;
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);
beforeEach(() => {
  runBeforeSend.mockClear();
  completeFollowupTurn.mockClear();
});

const base = {
  followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
  node_id: "node-1",
  purpose: "send_message",
};

describe("pessoa no comando × política do fluxo, no envio sem IA", () => {
  it("allow: o texto fixo SAI mesmo com a conversa assumida", async () => {
    await criarHandler(deps())(job({ ...base, fixed_body: "Obrigado pela confirmação!!" }), fakePool("allow").pool, { workerId: "w1" });
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn.mock.calls[0]?.[1]).toMatchObject({ result: { kind: "sent" } });
  });

  it("allow: o bloco de mensagens manda os dois itens, na ordem", async () => {
    await criarHandler(deps())(
      job({ ...base, fixed_items: [{ kind: "text", body: "um" }, { kind: "text", body: "Fico no seu aguardo!!" }] }),
      fakePool("allow").pool,
      { workerId: "w1" },
    );
    expect(runBeforeSend.mock.calls.map((c) => c[0].body)).toEqual(["um", "Fico no seu aguardo!!"]);
    expect(completeFollowupTurn.mock.calls[0]?.[1]).toMatchObject({ result: { kind: "sent" } });
  });

  it("pause (o padrão): a conversa assumida CONTINUA barrando o envio", async () => {
    await criarHandler(deps())(job({ ...base, fixed_body: "oi" }), fakePool("pause").pool, { workerId: "w1" });
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(completeFollowupTurn.mock.calls[0]?.[1]).toMatchObject({ result: { kind: "skipped" } });
  });
});
