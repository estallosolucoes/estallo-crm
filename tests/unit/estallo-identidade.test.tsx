// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_APP_NAME, branding } from "@/lib/branding";
import { marcaDaPlataforma } from "@/lib/branding/plataforma";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { razaoDeContraste } from "@/lib/branding/contraste";
import { PLANOS_DEMONSTRATIVOS } from "@/lib/planos/catalogo";
import { PlanosDemonstrativos } from "@/components/plans/PlanosDemonstrativos";
import { buttonVariants } from "@/components/ui/button";
import { GRAUS } from "@/lib/branding/rampa";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("identidade fixa do SaaS", () => {
  it("o ambiente legado não altera a identidade pública", () => {
    vi.stubEnv("APP_NAME", "Outra plataforma");
    vi.stubEnv("APP_LOGO_URL", "https://example.test/outra.svg");
    expect(branding().name).toBe(DEFAULT_APP_NAME);
    expect(marcaDaPlataforma().name).toBe(DEFAULT_APP_NAME);
    expect(marcaDaPlataforma().logoUrl).toBeNull();
    expect(marcaDaPlataforma().cor).toBeNull();
  });
  it.each(["claro", "escuro"] as const)("texto de ação permanece legível no tema %s", (tema) => {
    // Mede a superfície realmente usada pelo botão, incluindo o override escuro.
    // Links usam o accent claro; usá-lo como fundo com branco causava 2,16:1.
    for (const variant of ["default", "primary"] as const) {
      const classes = buttonVariants({ variant });
      expect(classes).toContain("text-accent-foreground");
      for (const hover of [false, true]) {
        const prefixo = `${tema === "escuro" ? "dark:" : ""}${hover ? "hover:" : ""}`;
        const grau = classes
          .split(" ")
          .find((c) => c.startsWith(`${prefixo}bg-accent-`))
          ?.slice(`${prefixo}bg-accent-`.length);
        const indice =
          grau && /^\d+$/.test(grau)
            ? GRAUS.findIndex((g) => String(g) === grau)
            : REGUA_DO_PRODUTO[tema].indices[hover ? "hover" : "accent"];
        const fundo = REGUA_DO_PRODUTO.rampaDoProduto[indice]!;
        expect(
          razaoDeContraste(fundo, "#ffffff"),
          `${variant}, hover=${hover}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("planos demonstrativos", () => {
  it("informa os preços e que não há cobrança nem limites aplicados", () => {
    const html = renderToStaticMarkup(<PlanosDemonstrativos idioma="pt-BR" />);
    for (const plano of PLANOS_DEMONSTRATIVOS) expect(html).toContain(plano.nome);
    expect(html).toContain("Nenhuma cobrança será feita");
    expect(html).toContain("ainda não são aplicados");
    expect(html).toMatch(/R\$[^0-9]*97/);
    expect(html).toMatch(/R\$[^0-9]*197/);
    expect(html).toMatch(/R\$[^0-9]*397/);
  });
  it("não oferece checkout, seleção de plano ou link de pagamento", () => {
    const html = renderToStaticMarkup(<PlanosDemonstrativos idioma="pt-BR" />);
    const botoes = html.match(/<button[^>]*>/g) ?? [];
    expect(botoes).toHaveLength(3);
    for (const botao of botoes) expect(botao).toMatch(/disabled/);
    expect(html).not.toMatch(/<a[\s>]|<input[\s>]|<form[\s>]/);
  });
});
