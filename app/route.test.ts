import { beforeEach, describe, expect, it, vi } from "vitest";

const cena = vi.hoisted(() => ({ usuario: null as { id: string } | null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: cena.usuario } }) },
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  cena.usuario = null;
});

describe("/ — a página inicial pública", () => {
  it("sem sessão: entrega a landing com os links de login e os legais", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Estallo CRM");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });

  it("com sessão: segue direto para o painel", async () => {
    cena.usuario = { id: "11111111-1111-4111-8111-111111111111" };
    const res = await GET();
    expect(res.status).toBe(307);
    // relativo: o host interno do container nunca vaza para o navegador
    expect(res.headers.get("location")).toBe("/app");
  });
});
