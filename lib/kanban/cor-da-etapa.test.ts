import { describe, expect, it } from "vitest";
import { COR_DE_ETAPA, PALETA_DE_ETAPAS, corParaNovaEtapa } from "./cor-da-etapa";

describe("corParaNovaEtapa", () => {
  it("nunca repete a cor da etapa anterior, em todo sorteio possível", () => {
    for (const anterior of PALETA_DE_ETAPAS) {
      for (let i = 0; i < 20; i++) {
        const cor = corParaNovaEtapa(anterior.toUpperCase(), () => i / 20);
        expect(cor).not.toBe(anterior);
        expect(cor).toMatch(COR_DE_ETAPA);
      }
    }
  });

  it("sem etapa anterior, sorteia da paleta inteira", () => {
    expect(corParaNovaEtapa(null, () => 0)).toBe(PALETA_DE_ETAPAS[0]);
    expect(corParaNovaEtapa(undefined, () => 0.999)).toBe(PALETA_DE_ETAPAS.at(-1));
  });
});
