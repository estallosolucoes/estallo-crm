import { describe, expect, it } from "vitest";

import { filtrarLinhas, jsonParaCopiar, linhasDoValor, tipoDoValor } from "./dados-para-inspecao";

describe("tipoDoValor — ausência não vira vazio", () => {
  it("separa sem valor, nulo, texto vazio, lista vazia e objeto vazio", () => {
    expect(tipoDoValor(undefined)).toBe("ausente");
    expect(tipoDoValor(null)).toBe("nulo");
    expect(tipoDoValor("")).toBe("texto_vazio");
    expect(tipoDoValor([])).toBe("lista_vazia");
    expect(tipoDoValor({})).toBe("objeto_vazio");
  });
  it("0 e false são valores, não ausência", () => {
    expect(tipoDoValor(0)).toBe("numero");
    expect(tipoDoValor(false)).toBe("booleano");
  });
});

describe("linhasDoValor", () => {
  it("achata objetos e listas com caminho estruturado", () => {
    const { linhas } = linhasDoValor({ lead: { id: "a", tags: ["x", "y"] }, vazio: "" });
    expect(linhas.map((l) => l.caminho)).toEqual(["", "lead", "lead.id", "lead.tags", "lead.tags[0]", "lead.tags[1]", "vazio"]);
    expect(linhas.find((l) => l.caminho === "vazio")).toMatchObject({ tipo: "texto_vazio", valor: '""' });
    expect(linhas.find((l) => l.caminho === "lead.tags")?.valor).toBe("2 itens");
  });
  it("corta em 500 linhas e avisa", () => {
    const r = linhasDoValor(Array.from({ length: 800 }, (_, i) => i));
    expect(r.linhas).toHaveLength(500);
    expect(r.cortado).toBe(true);
  });
});

describe("filtrarLinhas / jsonParaCopiar", () => {
  const { linhas } = linhasDoValor({ nome: "Ana", cidade: "Recife" });
  it("busca por caminho ou valor", () => {
    expect(filtrarLinhas(linhas, "recife").map((l) => l.caminho)).toEqual(["cidade"]);
    expect(filtrarLinhas(linhas, "nom").map((l) => l.caminho)).toEqual(["nome"]);
    expect(filtrarLinhas(linhas, "  ")).toHaveLength(linhas.length);
  });
  it("sem valor aparece escrito, não some", () => {
    expect(jsonParaCopiar(undefined)).toBe("(sem valor)");
    expect(jsonParaCopiar(null)).toBe("null");
  });
});
