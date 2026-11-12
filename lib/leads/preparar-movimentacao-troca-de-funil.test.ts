import { describe, expect, it } from "vitest";

import { prepararMovimentacaoDeLead } from "./preparar-movimentacao";

const lead = { id: "l", pipeline_id: "p1", stage_id: "s1", status: "open" };
const etapaOutroFunil = { id: "s9", pipeline_id: "p2", name: "Novo", is_won: false, is_lost: false };

describe("troca de funil pelo bloco Mover (Fase 5)", () => {
  it("sem a opção recusa como sempre (handler da API e quadro)", () => {
    expect(prepararMovimentacaoDeLead({ lead, etapa: etapaOutroFunil, settings: null })).toMatchObject({
      ok: false,
      codigo: "pipeline_immutable_use_clone",
    });
  });
  it("com a opção, negócio aberto vai para etapa aberta de outro funil", () => {
    expect(prepararMovimentacaoDeLead({ lead, etapa: etapaOutroFunil, settings: null, permitirTrocaDeFunil: true })).toMatchObject({
      ok: true,
    });
  });
  it("negócio fechado não muda de funil; etapa de ganho/perda de outro funil é recusada", () => {
    expect(
      prepararMovimentacaoDeLead({ lead: { ...lead, status: "won" }, etapa: etapaOutroFunil, settings: null, permitirTrocaDeFunil: true }),
    ).toMatchObject({ ok: false, codigo: "lead_not_open" });
    expect(
      prepararMovimentacaoDeLead({ lead, etapa: { ...etapaOutroFunil, is_won: true }, settings: null, permitirTrocaDeFunil: true }),
    ).toMatchObject({ ok: false, codigo: "destino_fechado" });
  });
});
