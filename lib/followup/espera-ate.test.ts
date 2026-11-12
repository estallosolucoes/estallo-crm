import { describe, expect, it } from "vitest";

import { alvoDaEsperaAte } from "./espera-ate";

const SP = "America/Sao_Paulo"; // UTC-3, sem horário de verão desde 2019

describe("alvoDaEsperaAte — esperar até data/horário no fuso da organização", () => {
  it("só hora: hoje se ainda não passou, amanhã se já passou (no relógio do fuso, não do servidor)", () => {
    const agora = new Date("2026-11-11T12:00:00Z"); // 09:00 em SP
    expect(alvoDaEsperaAte({ hora: "10:30" }, SP, agora)).toEqual({ ok: true, alvo: new Date("2026-11-11T13:30:00Z"), ja_passou: false });
    expect(alvoDaEsperaAte({ hora: "08:00" }, SP, agora)).toEqual({ ok: true, alvo: new Date("2026-11-12T11:00:00Z"), ja_passou: false });
  });

  it("virada do dia no fuso: 23:30 em SP já é o dia seguinte em UTC", () => {
    const agora = new Date("2026-11-12T02:30:00Z"); // 23:30 do dia 11 em SP
    expect(alvoDaEsperaAte({ hora: "08:00" }, SP, agora)).toEqual({ ok: true, alvo: new Date("2026-11-12T11:00:00Z"), ja_passou: false });
  });

  it("data e hora: esse instante; já passado segue e avisa", () => {
    const agora = new Date("2026-11-11T12:00:00Z");
    expect(alvoDaEsperaAte({ data: "2026-12-01", hora: "09:00" }, SP, agora)).toEqual({
      ok: true,
      alvo: new Date("2026-12-01T12:00:00Z"),
      ja_passou: false,
    });
    expect(alvoDaEsperaAte({ data: "2026-11-01", hora: "09:00" }, SP, agora)).toMatchObject({ ok: true, ja_passou: true });
  });

  it("horário de verão é respeitado (Nova York muda o offset em março)", () => {
    const agora = new Date("2026-03-01T00:00:00Z");
    expect(alvoDaEsperaAte({ data: "2026-03-20", hora: "09:00" }, "America/New_York", agora)).toMatchObject({
      alvo: new Date("2026-03-20T13:00:00Z"), // EDT, UTC-4
    });
  });

  it("data ou hora inexistente falha com explicação, nunca é corrigida em silêncio", () => {
    const agora = new Date("2026-11-11T12:00:00Z");
    expect(alvoDaEsperaAte({ data: "2026-02-31", hora: "09:00" }, SP, agora)).toMatchObject({ ok: false });
    expect(alvoDaEsperaAte({ hora: "25:00" }, SP, agora)).toMatchObject({ ok: false });
    expect(alvoDaEsperaAte({ hora: "9:00" }, SP, agora)).toMatchObject({ ok: false });
  });
});
