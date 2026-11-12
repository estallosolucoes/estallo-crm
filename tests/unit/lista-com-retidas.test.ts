import { describe, expect, it } from "vitest";
import { listaComRetidas } from "@/lib/inbox/lista-com-retidas";

/**
 * Responder em "Em espera" muda o status e a lista relida não traz mais a
 * conversa: ela fica no lugar em que estava até o atendente trocar de aba.
 */
describe("listaComRetidas", () => {
  const c = (id: string) => ({ id });

  it("sem retidas, a lista do servidor passa intacta (mesma referência)", () => {
    const itens = [c("a"), c("b")];
    expect(listaComRetidas(itens, [])).toBe(itens);
  });

  it("a retida que saiu da lista volta na posição em que estava", () => {
    const depois = [c("a"), c("c")];
    expect(listaComRetidas(depois, [{ conversa: c("b"), indice: 1 }]).map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("a retida que continua na lista não duplica", () => {
    expect(listaComRetidas([c("a"), c("b")], [{ conversa: c("b"), indice: 0 }]).map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("posição além do fim vai para o fim; várias retidas mantêm a ordem", () => {
    const out = listaComRetidas(
      [c("x")],
      [
        { conversa: c("r2"), indice: 9 },
        { conversa: c("r1"), indice: 0 },
      ],
    );
    expect(out.map((x) => x.id)).toEqual(["r1", "x", "r2"]);
  });
});
