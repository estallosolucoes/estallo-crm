import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "mudou de etapa",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const P1 = "44444444-4444-4444-8444-444444444444";
const P2 = "55555555-5555-4555-8555-555555555555";
const S1 = "66666666-6666-4666-8666-666666666666";
const S2 = "88888888-8888-4888-8888-888888888888";
const S2_WON = "99999999-9999-4999-8999-999999999999";
const CARIMBO = "2026-10-14T10:00:00.000Z";

type Row = Record<string, unknown>;

/** Fake mínimo: select/eq/order/limit/maybeSingle e update filtrado. */
function fakeDb(tables: Record<string, Row[]>) {
  function from(table: string) {
    const filters: [string, unknown][] = [];
    let patch: Row | null = null;
    const rows = () => tables[table] ?? [];
    const matches = () => rows().filter((r) => filters.every(([c, v]) => r[c] === v));
    const builder = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
      order: () => builder,
      limit: () => builder,
      update: (p: Row) => ((patch = p), builder),
      maybeSingle: async () => {
        const alvo = matches()[0] ?? null;
        if (patch && alvo) Object.assign(alvo, patch);
        return { data: alvo, error: null };
      },
    };
    return builder;
  }
  return { from } as never;
}

let tables: Record<string, Row[]>;

beforeEach(() => {
  vi.clearAllMocks();
  tables = {
    crm_pipelines: [{ id: P2, organization_id: ORG, settings: {} }],
    crm_stages: [
      { id: S1, organization_id: ORG, pipeline_id: P1, name: "Novo", is_won: false, is_lost: false, is_archived: false, crm_pipelines: { is_archived: false } },
      { id: S2, organization_id: ORG, pipeline_id: P2, name: "Triagem", is_won: false, is_lost: false, is_archived: false, crm_pipelines: { is_archived: false } },
      { id: S2_WON, organization_id: ORG, pipeline_id: P2, name: "Ganho", is_won: true, is_lost: false, is_archived: false, crm_pipelines: { is_archived: false } },
    ],
    crm_leads: [
      { id: LEAD, organization_id: ORG, pipeline_id: P1, stage_id: S1, status: "open", contact_id: null, custom_fields: { cpf: "1" }, position_in_stage: 1000, updated_at: CARIMBO },
    ],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(createClient).mockResolvedValue(fakeDb(tables));
});

const pedir = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move-pipeline`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const params = { params: Promise.resolve({ id: LEAD }) };

describe("POST /api/v1/leads/[id]/move-pipeline", () => {
  it("move o MESMO negócio para a etapa do outro funil, com campos intactos e auditoria", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedir({ stage_id: S2, expected_updated_at: CARIMBO }), params);

    expect(res.status).toBe(200);
    expect(tables.crm_leads![0]).toMatchObject({
      id: LEAD,
      pipeline_id: P2,
      stage_id: S2,
      status: "open",
      custom_fields: { cpf: "1" },
    });
    expect(tables.crm_leads).toHaveLength(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lead.moved_to_pipeline",
        metadata: expect.objectContaining({ from_pipeline_id: P1, to_pipeline_id: P2 }),
      }),
    );
  });

  it("recusa etapa de ganho/perda como destino (fecha por outro botão)", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedir({ stage_id: S2_WON, expected_updated_at: CARIMBO }), params);
    expect(res.status).toBe(422);
    expect(tables.crm_leads![0]!.pipeline_id).toBe(P1);
  });

  it("recusa etapa do mesmo funil (isso é o /move)", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedir({ stage_id: S1, expected_updated_at: CARIMBO }), params);
    expect(res.status).toBe(422);
  });

  it("carimbo velho → 409, nada muda", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedir({ stage_id: S2, expected_updated_at: "2020-01-01T00:00:00Z" }), params);
    expect(res.status).toBe(409);
    expect(tables.crm_leads![0]!.pipeline_id).toBe(P1);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("negócio já fechado não muda de funil", async () => {
    tables.crm_leads![0]!.status = "won";
    const { POST } = await import("./route");
    const res = await POST(pedir({ stage_id: S2, expected_updated_at: CARIMBO }), params);
    expect(res.status).toBe(422);
  });
});
