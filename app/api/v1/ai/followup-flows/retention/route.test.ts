import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  client: vi.fn(),
  admin: vi.fn(),
  rpc: vi.fn(),
  eq: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));

import { GET, PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const request = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/followup-flows/retention", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  });
  deps.support.mockResolvedValue(null);
  deps.rpc.mockResolvedValue({ data: true, error: null });
  deps.admin.mockReturnValue({ rpc: deps.rpc });
  deps.read.mockResolvedValue({ data: { settings: {} }, error: null });
  deps.eq.mockReturnValue({ maybeSingle: deps.read });
  deps.client.mockResolvedValue({ from: () => ({ select: () => ({ eq: deps.eq }) }) });
});

describe("política de retenção de automações", () => {
  it("lê da organização autenticada e retorna defaults sem expor settings inteiros", async () => {
    deps.read.mockResolvedValue({
      data: {
        settings: {
          unrelated: "privado",
          automations: { retention: { payload_days: 15, metadata_days: 365 } },
        },
      },
      error: null,
    });
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(deps.role).toHaveBeenCalledWith("manager", expect.any(Object));
    expect(deps.eq).toHaveBeenCalledWith("id", ORG);
    expect(body.data.policy).toEqual({ payload_days: 15, metadata_days: 365 });
    expect(body.data.configuration_valid).toBe(true);
    expect(JSON.stringify(body)).not.toContain("privado");
  });

  it("mostra a configuração inválida em vez de aplicar valores parciais", async () => {
    deps.read.mockResolvedValue({
      data: { settings: { automations: { retention: { payload_days: 500, metadata_days: 365 } } } },
      error: null,
    });
    const body = await (await GET()).json();
    expect(body.data.policy).toEqual({ payload_days: 30, metadata_days: 180 });
    expect(body.data.configuration_valid).toBe(false);
  });

  it("grava por operação atômica e audita só os prazos", async () => {
    const response = await PATCH(request({ payload_days: 14, metadata_days: 90 }));
    expect(response.status).toBe(200);
    expect(deps.rpc).toHaveBeenCalledWith("fn_set_followup_retention_policy", {
      p_org: ORG,
      p_policy: { payload_days: 14, metadata_days: 90 },
    });
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup.retention_updated",
        organizationId: ORG,
        actorUserId: USER,
        metadata: { payload_days: 14, metadata_days: 90 },
      }),
    );
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  it.each([
    {},
    { payload_days: 7 },
    { payload_days: 30, metadata_days: 15 },
    { payload_days: 14, metadata_days: 90, organization_id: "outra" },
  ])("recusa configuração inválida, parcial ou organização no body: %j", async (body) => {
    expect((await PATCH(request(body))).status).toBe(422);
    expect(deps.admin).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("impede escrita de suporte somente leitura antes do client privilegiado", async () => {
    deps.support.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await PATCH(request({ payload_days: 30, metadata_days: 180 }))).status).toBe(403);
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("respeita a recusa de papel na leitura e na escrita", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect((await PATCH(request({ payload_days: 30, metadata_days: 180 }))).status).toBe(403);
    expect(deps.client).not.toHaveBeenCalled();
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("não informa sucesso nem audita se a escrita no banco falhar", async () => {
    deps.rpc.mockResolvedValue({ data: null, error: { message: "falha sintética" } });
    expect((await PATCH(request({ payload_days: 30, metadata_days: 180 }))).status).toBe(500);
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
