import { describe, expect, it } from "vitest";

import { aplicarTags } from "./tags";

describe("aplicarTags — adicionar e remover (Fase 5)", () => {
  it("remover tira só as tags pedidas que existem; as outras ficam, na ordem", () => {
    expect(aplicarTags(["a", "b", "c"], ["b", "x"], "remove")).toEqual({ added: [], removed: ["b"], tags: ["a", "c"] });
  });
  it("adicionar é a regra de sempre (sem duplicar), sem remover nada", () => {
    expect(aplicarTags(["a"], ["a", "b"])).toEqual({ added: ["b"], removed: [], tags: ["a", "b"] });
  });
});
