import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FALHA DE CANAL NÃO É "SEM FOTO" (17/10/2026).
 *
 * O cron carimbava toda falha — canal fora, WAHA reiniciando, upload com erro —
 * como "sem foto" por 7 dias. Numa troca de servidor isso marcou 1.561 contatos
 * de uma vez. Agora: o canal RESPONDER sem foto carimba 7 dias; o canal FALHAR
 * devolve o contato à fila em ~1 h.
 */

const CONTATO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DIA = 86_400_000;

let respostaDoCanal: () => Promise<string | null> = async () => null;
const carimbos: string[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  getAdapter: () => ({ fetchProfilePictureUrl: () => respostaDoCanal() }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const dados =
          tabela === "contacts"
            ? [{ id: CONTATO, organization_id: ORG, wa_identity: "phone:+5511999990000", wa_lid: null, phone_number: "+5511999990000", avatar_storage_path: null }]
            : tabela === "channel_sessions"
              ? [{ id: "s1", waha_session_name: "sessao", provider: "waha" }]
              : { channel_session_id: "s1" };
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
              }
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: (patch: { avatar_updated_at: string }) => {
        carimbos.push(patch.avatar_updated_at);
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "select") return () => Promise.resolve({ data: [{ id: CONTATO }], error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

function chamar() {
  return POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

beforeEach(() => {
  carimbos.length = 0;
});

describe("cron de fotos: sem foto × falha", () => {
  it("o canal respondeu sem foto: carimbo de agora (volta em 7 dias)", async () => {
    respostaDoCanal = async () => null;
    await chamar();
    expect(carimbos).toHaveLength(1);
    expect(Math.abs(Date.parse(carimbos[0]!) - Date.now())).toBeLessThan(60_000);
  });

  it("o canal falhou: carimbo 7 dias no passado + 1 h (volta à fila em ~1 h)", async () => {
    respostaDoCanal = async () => {
      throw new Error("profile-picture respondeu 502");
    };
    await chamar();
    expect(carimbos).toHaveLength(1);
    const esperado = Date.now() - 7 * DIA + 60 * 60 * 1000;
    expect(Math.abs(Date.parse(carimbos[0]!) - esperado)).toBeLessThan(60_000);
  });
});
