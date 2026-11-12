import { describe, expect, it } from "vitest";

import { duracaoCurta } from "./duracao-curta";

const AGORA = new Date("2026-11-05T12:00:00Z");

describe("duracaoCurta", () => {
  it("mede do início ao fim quando a execução terminou", () => {
    expect(duracaoCurta("2026-11-05T10:00:00Z", "2026-11-05T10:12:00Z", AGORA)).toBe("12 min");
    expect(duracaoCurta("2026-11-05T06:00:00Z", "2026-11-05T09:00:00Z", AGORA)).toBe("3 h");
    expect(duracaoCurta("2026-11-01T12:00:00Z", "2026-11-03T12:00:00Z", AGORA)).toBe("2 d");
  });
  it("em andamento, mede até agora", () => {
    expect(duracaoCurta("2026-11-05T11:30:00Z", null, AGORA)).toBe("30 min");
  });
  it("menos de um minuto", () => {
    expect(duracaoCurta("2026-11-05T11:59:50Z", null, AGORA)).toBe("<1 min");
  });
  it("sem início, data inválida ou fim antes do início: sem valor, nunca inventa", () => {
    expect(duracaoCurta(null, null, AGORA)).toBeNull();
    expect(duracaoCurta("lixo", null, AGORA)).toBeNull();
    expect(duracaoCurta("2026-11-05T12:00:00Z", "2026-11-05T11:00:00Z", AGORA)).toBeNull();
  });
});
