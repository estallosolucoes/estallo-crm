/**
 * POST /api/v1/ai/followups/enrollments/:id/restart — a borda do reinício: papel, id, recusas legíveis e o recibo
 * de idempotência. A regra do reinício em si é medida em `lib/followup/reiniciar.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reiniciar: vi.fn(),
  requireRole: vi.fn(),
  support: vi.fn(),
  idem: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/followup/reiniciar", () => ({ reiniciarExecucao: mocks.reiniciar }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/api/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/idempotency")>()),
  comIdempotencia: mocks.idem,
}));

import { POST } from "@/app/api/v1/ai/followups/enrollments/[id]/restart/route";

const ID = "11111111-1111-4111-8111-111111111111";
const NOVA = { id: "22222222-2222-4222-8222-222222222222", source_enrollment_id: ID, status: "active", version_id: "v1" };

const chamar = (id = ID, headers: Record<string, string> = {}) =>
  POST(new NextRequest(`http://localhost/x/${id}/restart`, { method: "POST", headers }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.support.mockResolvedValue(null);
  mocks.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: "org-1" },
  });
  mocks.reiniciar.mockResolvedValue({ ok: true, enrollment: NOVA });
});

describe("POST …/restart", () => {
  it("exige manager: quem não tem o papel recebe a resposta do guarda e nada é criado", async () => {
    mocks.requireRole.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });

  it("suporte em modo leitura é barrado antes do efeito", async () => {
    mocks.support.mockResolvedValue(new Response("{}", { status: 403 }));
    expect((await chamar()).status).toBe(403);
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });

  it("id que não é uuid → 400 sem tocar no banco", async () => {
    const res = await chamar("nao-e-uuid");
    expect(res.status).toBe(400);
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });

  it("sem chave: cria e responde 201 com a execução nova; a organização vem da sessão", async () => {
    const res = await chamar();
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(NOVA.id);
    expect(mocks.reiniciar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", enrollmentId: ID, actorUserId: "u1" }),
    );
  });

  it("recusa de regra vira o status e o código da regra (409 ainda viva)", async () => {
    mocks.reiniciar.mockResolvedValue({ ok: false, code: "execucao_ainda_viva", message: "Ainda em andamento.", status: 409 });
    const res = await chamar();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("execucao_ainda_viva");
  });

  it("com Idempotency-Key: o efeito roda dentro do recibo; replay devolve a mesma execução sem criar outra", async () => {
    mocks.idem.mockImplementation(async (e: { executar: () => Promise<{ resposta: unknown; status: number }> }) => {
      const r = await e.executar();
      return { tipo: "executou", ...r };
    });
    expect((await chamar(ID, { "Idempotency-Key": "abc-123" })).status).toBe(201);
    expect(mocks.reiniciar).toHaveBeenCalledTimes(1);

    mocks.idem.mockResolvedValue({ tipo: "replay", resposta: NOVA, status: 201 });
    mocks.reiniciar.mockClear();
    const res = await chamar(ID, { "Idempotency-Key": "abc-123" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe(NOVA.id);
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });

  it("com chave: a recusa da regra não vira recibo e sai com o status dela", async () => {
    mocks.reiniciar.mockResolvedValue({ ok: false, code: "contato_bloqueado", message: "Bloqueado.", status: 422 });
    mocks.idem.mockImplementation(async (e: { executar: () => Promise<unknown> }) => e.executar());
    const res = await chamar(ID, { "Idempotency-Key": "k1" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("contato_bloqueado");
  });

  it("mesma chave, requisição ainda em curso → 409 idempotency_in_progress", async () => {
    mocks.idem.mockResolvedValue({ tipo: "em_curso" });
    const res = await chamar(ID, { "Idempotency-Key": "k2" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("idempotency_in_progress");
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });

  it("corpo opcional: {passo_a_passo: true} chega à regra; sem corpo, não", async () => {
    const comCorpo = new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ passo_a_passo: true }) });
    await POST(comCorpo, { params: Promise.resolve({ id: ID }) });
    expect(mocks.reiniciar).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ passoAPasso: true }));
    await chamar();
    expect(mocks.reiniciar).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ passoAPasso: false }));
  });

  it("corpo com campo desconhecido ou JSON quebrado é recusado antes de qualquer efeito", async () => {
    mocks.reiniciar.mockClear();
    const quebrado = new NextRequest("http://localhost/x", { method: "POST", body: "{lixo" });
    expect((await POST(quebrado, { params: Promise.resolve({ id: ID }) })).status).toBe(400);
    const extra = new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ voar: 1 }) });
    expect((await POST(extra, { params: Promise.resolve({ id: ID }) })).status).toBe(422);
    expect(mocks.reiniciar).not.toHaveBeenCalled();
  });
});
