import { describe, expect, it } from "vitest";

import { RITMO_MAXIMO_MS, RITMO_MINIMO_MS, reservarRitmo } from "./ritmo-entre-envios";

describe("ritmo entre envios", () => {
  it("o primeiro envio do número não espera", () => {
    expect(reservarRitmo("n-primeiro", 1_000, () => 0.5)).toBe(0);
  });

  it("o segundo espera o intervalo sorteado, entre 0,3 e 0,8 s", () => {
    reservarRitmo("n-a", 1_000, () => 0);
    expect(reservarRitmo("n-a", 1_000, () => 0)).toBe(RITMO_MINIMO_MS);
    reservarRitmo("n-b", 1_000, () => 0);
    expect(reservarRitmo("n-b", 1_000, () => 0.999999)).toBe(RITMO_MAXIMO_MS);
  });

  it("desconta o tempo que já passou desde o envio anterior", () => {
    reservarRitmo("n-c", 1_000, () => 0);
    expect(reservarRitmo("n-c", 1_200, () => 0)).toBe(RITMO_MINIMO_MS - 200);
    reservarRitmo("n-d", 1_000, () => 0);
    expect(reservarRitmo("n-d", 5_000, () => 0.5)).toBe(0);
  });

  it("números diferentes não se esperam", () => {
    reservarRitmo("n-e", 1_000, () => 0.5);
    expect(reservarRitmo("n-f", 1_000, () => 0.5)).toBe(0);
  });
});
