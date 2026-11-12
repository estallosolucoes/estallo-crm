import { describe, expect, it } from "vitest";

import { VariavelSemValorError, interpolarVolta } from "./engine";

describe("variável de bloco sem valor", () => {
  const nodes = { "cond-produto": { branch_id: "coleta_vca" } };

  it("com a saída carregada, resolve a variável que tem valor", () => {
    expect(interpolarVolta("Produto: {{nodes.cond-produto.branch_id}}", [], { nodes })).toBe("Produto: coleta_vca");
  });

  it("com a saída carregada, falha em vez de mandar a frase com o pedaço sumido", () => {
    expect(() => interpolarVolta("Seu link: {{nodes.cond-produto.link}}", [], { nodes })).toThrow(VariavelSemValorError);
    try {
      interpolarVolta("Seu link: {{nodes.cond-produto.link}} e {{nodes.outro.x}}", [], { nodes });
    } catch (e) {
      expect((e as VariavelSemValorError).marcas).toEqual(["{{nodes.cond-produto.link}}", "{{nodes.outro.x}}"]);
      expect((e as Error).message).toContain("{{nodes.outro.x}}");
    }
  });

  it("sem saídas carregadas (fluxo antigo) não há como saber: a marca some, como antes", () => {
    expect(interpolarVolta("Oi {{nodes.cond-produto.x}} tudo bem", [], {})).toBe("Oi tudo bem");
  });
});
