import { describe, expect, it } from "vitest";

import { centavosDoValor, converterValorDoCampo } from "./valor-do-campo";

const def = (type: string, options: Array<{ value: string; label: string }> = []) =>
  ({ key: "k", label: "Campo", type, options }) as never;

describe("converterValorDoCampo — pelo tipo da definição, sem corrigir em silêncio", () => {
  it("número e moeda aceitam formato brasileiro", () => {
    expect(converterValorDoCampo(def("number"), "1.234,50")).toEqual({ ok: true, valor: 1234.5 });
    expect(converterValorDoCampo(def("currency"), "R$ 99,90")).toEqual({ ok: true, valor: 99.9 });
    expect(converterValorDoCampo(def("number"), "doze").ok).toBe(false);
  });

  it("data ISO ou brasileira; data inexistente falha", () => {
    expect(converterValorDoCampo(def("date"), "15/03/2027")).toEqual({ ok: true, valor: "2027-03-15" });
    expect(converterValorDoCampo(def("date"), "2027-02-30").ok).toBe(false);
  });

  it("lista: só opção que existe, por valor ou rótulo", () => {
    const opcoes = [
      { value: "a", label: "Plano A" },
      { value: "b", label: "Plano B" },
    ];
    expect(converterValorDoCampo(def("select", opcoes), "plano b")).toEqual({ ok: true, valor: "b" });
    expect(converterValorDoCampo(def("select", opcoes), "Plano C").ok).toBe(false);
    expect(converterValorDoCampo(def("multiselect", opcoes), "a, Plano B")).toEqual({ ok: true, valor: ["a", "b"] });
  });

  it("sim/não, e-mail e vazio", () => {
    expect(converterValorDoCampo(def("boolean"), "Sim")).toEqual({ ok: true, valor: true });
    expect(converterValorDoCampo(def("email"), "x@y").ok).toBe(false);
    expect(converterValorDoCampo(def("text"), "   ").ok).toBe(false);
  });

  it("valor do negócio vira centavos; negativo ou texto não", () => {
    expect(centavosDoValor("1.500,00")).toBe(150000);
    expect(centavosDoValor("-3")).toBeNull();
    expect(centavosDoValor("abc")).toBeNull();
  });
});
