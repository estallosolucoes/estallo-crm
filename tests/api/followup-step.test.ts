/**
 * POST /api/v1/ai/followups/enrollments/:id/step — a borda do passo a passo: papel, corpo e o mapa de falhas. A regra
 * (`executaProximoBloco` / `continuaAutomaticamente`) é medida em `lib/followup/intervencao-passo-a-passo.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proximo: vi.fn(),
  continuar: vi.fn(),
  requireRole: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/followup/intervencao", async (orig) => ({
  ...(await orig<typeof import("@/lib/followup/intervencao")>()),
  executaProximoBloco: mocks.proximo,
  continuaAutomaticamente: mocks.continuar,
}));

import { POST } from "@/app/api/v1/ai/followups/enrollments/[id]/step/route";

const ID = "11111111-1111-4111-8111-111111111111";
const OK = {
  ok: true,
  enrollment: { id: ID, current_node_id: "w" },
  status_novo: "active",
  next_eval_at: "2026-11-05T12:00:00.000Z",
};

const chamar = (corpo: unknown, id = ID) =>
  POST(
    new NextRequest(`http://localhost/x/${id}/step`, {
      method: "POST",
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.support.mockResolvedValue(null);
  mocks.requireRole.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-1" } });
  mocks.proximo.mockResolvedValue(OK);
  mocks.continuar.mockResolvedValue(OK);
});

describe("POST …/step", () => {
  it("exige manager e suporte com escrita; nada roda sem isso", async () => {
    mocks.requireRole.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    expect((await chamar({ acao: "proximo" })).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith("manager", expect.anything());
    mocks.requireRole.mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-1" } });
    mocks.support.mockResolvedValue(new Response("{}", { status: 403 }));
    expect((await chamar({ acao: "proximo" })).status).toBe(403);
    expect(mocks.proximo).not.toHaveBeenCalled();
  });

  it("id inválido → 400; corpo inválido → 400/422, sem tocar na execução", async () => {
    expect((await chamar({ acao: "proximo" }, "nao-e-uuid")).status).toBe(400);
    expect((await chamar("{lixo")).status).toBe(400);
    expect((await chamar({ acao: "voar" })).status).toBe(422);
    expect((await chamar({ acao: "proximo", extra: 1 })).status).toBe(422);
    expect(mocks.proximo).not.toHaveBeenCalled();
    expect(mocks.continuar).not.toHaveBeenCalled();
  });

  it("«proximo» executa o próximo bloco na organização da sessão e audita", async () => {
    const res = await chamar({ acao: "proximo" });
    expect(res.status).toBe(200);
    expect(mocks.proximo).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", userId: "u1" }), ID);
    expect(mocks.continuar).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_enrollment.step_executed", resourceId: ID, organizationId: "org-1" }),
    );
  });

  it("«continuar» solta a execução e audita com outra ação", async () => {
    expect((await chamar({ acao: "continuar" })).status).toBe(200);
    expect(mocks.continuar).toHaveBeenCalled();
    expect(mocks.proximo).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "followup_enrollment.auto_continued" }));
  });

  it("estado incompatível e motor ocupado viram 409 e não auditam", async () => {
    mocks.proximo.mockResolvedValue({ ok: false, codigo: "motor_ocupado", mensagem: "O automático está executando." });
    const res = await chamar({ acao: "proximo" });
    expect(res.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
