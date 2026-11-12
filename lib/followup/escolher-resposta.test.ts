import { describe, expect, it } from "vitest";

import { BODY_PREVIEW_MAX, escolherResposta } from "./node-handlers";

describe("escolherResposta (match_reply no contrato 1)", () => {
  const recentes = [
    { id: "m3", body: "talvez" },
    { id: "m2", body: "Sim\n" },
    { id: "m1", body: " Sim " },
  ];

  it("sem texto do webhook: a mais recente", () => {
    expect(escolherResposta(recentes)).toEqual(recentes[0]);
    expect(escolherResposta([])).toBeNull();
  });

  it("com texto: a mais recente cujo corpo, sem espaços e quebras nas pontas, é esse texto", () => {
    expect(escolherResposta(recentes, "Sim")?.id).toBe("m2");
    expect(escolherResposta(recentes, " Sim\n")?.id).toBe("m2");
  });

  it("com texto que nenhuma mensagem tem: null (nunca outra mensagem)", () => {
    expect(escolherResposta(recentes, "Não")).toBeNull();
  });
});

describe("escolherResposta com a prévia cortada do webhook", () => {
  const longa = "Rua das Flores, 123, " + "apto 4, bloco B, perto da padaria. ".repeat(12);

  it("acha a mensagem longa pela prévia e devolve o corpo INTEIRO", () => {
    const previa = longa.slice(0, BODY_PREVIEW_MAX).trim();
    expect(longa.length).toBeGreaterThan(BODY_PREVIEW_MAX);
    expect(escolherResposta([{ id: "m1", body: longa }], previa)).toEqual({ id: "m1", body: longa });
  });

  it("texto curto nunca casa por prefixo com mensagem que só começa com ele", () => {
    expect(escolherResposta([{ id: "m1", body: "Sim, mas " + "x".repeat(300) }], "Sim")).toBeNull();
  });
});
