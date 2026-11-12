import { describe, expect, it } from "vitest";

import { campoVisivelNoLead, chaveDoRotulo, definicaoDeCampoSchema } from "./definicao";

describe("chaveDoRotulo", () => {
  it("tira acento e pontuação, e evita colisão", () => {
    expect(chaveDoRotulo("Qual é sua maior dificuldade hoje?")).toBe("qual_e_sua_maior_dificuldade_hoje");
    expect(chaveDoRotulo("Interesse", new Set(["interesse"]))).toBe("interesse_2");
    expect(chaveDoRotulo("2º contato")).toMatch(/^campo_2/);
  });
});

describe("campoVisivelNoLead", () => {
  const base = { hidden: false, visivel_global: false, funis_visiveis: ["p1"], etapas_visiveis: ["s9"] };
  it("global, funil inteiro ou a etapa do lead; oculto nunca", () => {
    expect(campoVisivelNoLead({ ...base, visivel_global: true }, null)).toBe(true);
    expect(campoVisivelNoLead(base, { pipeline_id: "p1", stage_id: "x" })).toBe(true);
    expect(campoVisivelNoLead(base, { pipeline_id: "p2", stage_id: "s9" })).toBe(true);
    expect(campoVisivelNoLead(base, { pipeline_id: "p2", stage_id: "x" })).toBe(false);
    expect(campoVisivelNoLead({ ...base, visivel_global: true, hidden: true }, null)).toBe(false);
  });
});

describe("definicaoDeCampoSchema", () => {
  it("lista de opções sem opção é recusada", () => {
    expect(definicaoDeCampoSchema.safeParse({ entity: "lead", label: "X", type: "select" }).success).toBe(false);
    expect(definicaoDeCampoSchema.safeParse({ entity: "contact", label: "CPF", type: "text" }).success).toBe(true);
  });
});
