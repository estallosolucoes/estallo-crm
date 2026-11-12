// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_NAME } from "@/lib/branding";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { razaoDeContraste } from "@/lib/branding/contraste";
const legado = vi.hoisted(() => ({
  ler: vi.fn(() => {
    throw new Error("Banco indisponível");
  }),
  suporte: vi.fn(),
}));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: legado.ler }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: legado.ler }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: legado.suporte }));
import { marcaDaSaida, emailDeSuporte } from "@/lib/branding/saida";
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
describe("saídas com identidade fixa", () => {
  it.each([null, "00000000-0000-4000-8000-000000000001"])(
    "não consulta configurações legadas nem depende do banco: %s",
    async (org) => {
      vi.stubEnv("APP_NAME", "Marca antiga");
      vi.stubEnv("APP_ACCENT_HEX", "#ff0000");
      const marca = await marcaDaSaida(org);
      expect(marca.nome).toBe(DEFAULT_APP_NAME);
      expect(marca.logoUrl).toBeNull();
      expect(marca.accent).toBe(
        REGUA_DO_PRODUTO.rampaDoProduto[REGUA_DO_PRODUTO.claro.indices.accent],
      );
      expect(razaoDeContraste(marca.accent, marca.accentFg)).toBeGreaterThanOrEqual(4.5);
      expect(legado.ler).not.toHaveBeenCalled();
    },
  );
  it("não inventa endereço de suporte", async () => {
    legado.suporte.mockResolvedValue({ valor: null });
    expect(await emailDeSuporte()).toBe("");
  });
  it("mantém o suporte configurado pela operação", async () => {
    legado.suporte.mockResolvedValue({ valor: " ajuda@example.test " });
    expect(await emailDeSuporte()).toBe("ajuda@example.test");
  });
});
