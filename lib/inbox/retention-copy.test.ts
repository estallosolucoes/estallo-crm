import { describe, expect, it } from "vitest";
import { retentionCopy } from "./retention-copy";

describe("retentionCopy — tradução leiga dos vetos before_send", () => {
  it("classifica stop/LGPD como conformidade", () => {
    expect(retentionCopy("contato_bloqueado").kind).toBe("compliance");
    expect(retentionCopy("lgpd_anonymized").kind).toBe("compliance");
    expect(retentionCopy("lgpd_missing_legal_basis").kind).toBe("compliance");
  });

  it("classifica promise/disclosure como qualidade", () => {
    expect(retentionCopy("promise_out_of_table").kind).toBe("quality");
    expect(retentionCopy("promise_semantic").kind).toBe("quality");
    expect(retentionCopy("disclosure_required").kind).toBe("quality");
  });

  it("código desconhecido ou null cai no fallback sem quebrar", () => {
    expect(retentionCopy(null).kind).toBe("protection");
    const unknown = retentionCopy("gate_novo_do_engine");
    expect(unknown.kind).toBe("protection");
    expect(unknown.description).toContain("gate_novo_do_engine");
  });
});
