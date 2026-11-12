import { describe, expect, it } from "vitest";

import { NODE_TYPES } from "./graph-schema";
import { NODE_CATALOG, nodeTypesForSurface, searchNodeTypes } from "./node-catalog";
import { NOS_DA_SUPERFICIE } from "./validate-publish";

describe("catálogo de nós executáveis", () => {
  it("não oferece nós sem contrato e mantém todos os tipos existentes", () => {
    expect(Object.keys(NODE_CATALOG)).toEqual([...NODE_TYPES]);
    expect(nodeTypesForSurface("atendimento")).toEqual(["trigger", "collect", "skill", "end"]);
    expect(nodeTypesForSurface("followup")).not.toContain("collect");
    expect(nodeTypesForSurface("followup")).not.toContain("skill");
  });

  it("usa as mesmas capacidades para paleta e publicação", () => {
    for (const surface of ["followup", "crm_automation", "atendimento"] as const) {
      expect(NOS_DA_SUPERFICIE[surface]).toEqual(nodeTypesForSurface(surface));
    }
  });

  it("encontra uma ação por nome comercial, sinônimo e acento", () => {
    expect(searchNodeTypes("followup", "vendedor")).toContain("internal_task");
    expect(searchNodeTypes("followup", "CONDICAO")).toEqual(["condition"]);
    expect(searchNodeTypes("followup", "mensagem texto")).toContain("action");
    expect(searchNodeTypes("followup", "habilidade")).toEqual([]);
    expect(searchNodeTypes("atendimento", "habilidade")).toEqual(["skill"]);
  });

  it("descreve o efeito real de adicionar tag, sem prometer remoção", () => {
    expect(NODE_CATALOG.edit_lead_tag.label).toBe("Adicionar tags ao lead");
    expect(NODE_CATALOG.edit_lead_tag.effect).toBe("crm");
    expect(NODE_CATALOG.action.effect).toBe("message");
  });
});
