import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ marca: vi.fn(), linha: vi.fn() }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: mocks.marca }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: mocks.linha }));
import manifest, { dynamic } from "@/app/manifest";
beforeEach(() => {
  mocks.marca.mockResolvedValue({ nome: "Central" });
  mocks.linha.mockResolvedValue(null);
});
describe("manifest do ícone configurável", () => {
  it("oferece os dois tamanhos reais, com leitura em runtime", async () => {
    const valor = await manifest();
    expect(dynamic).toBe("force-dynamic");
    expect(valor.icons).toEqual([
      { src: "/app-icon/192", sizes: "192x192", type: "image/png" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png" },
    ]);
  });
  it("arquivos legados não mudam os ícones do SaaS", async () => {
    mocks.linha.mockResolvedValue({ favicon_path: "platform/antigo.png" });
    const valor = await manifest();
    expect(valor.icons?.[0]?.src).toBe("/app-icon/192");
    expect(valor.start_url).toBe("/app");
    expect(mocks.linha).not.toHaveBeenCalled();
  });
});
