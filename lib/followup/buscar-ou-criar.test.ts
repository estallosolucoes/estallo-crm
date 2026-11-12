import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "./graph-schema";
import { validateFlowForPublish } from "./validate-publish";
import { dependentesDoNo } from "./variaveis-de-blocos";

/**
 * Buscar ou criar contato/negócio (Fase 5) e «Aplicar em»: um bloco seguinte mira o registro que o anterior entregou
 * por variável (`{{nodes.<bloco>.lead_id}}`). A publicação aceita só a marca de um bloco ANTERIOR, e só lead_id/contact_id.
 */
const FUNIL = "00000000-0000-4000-8000-0000000000f1";
const ETAPA = "00000000-0000-4000-8000-0000000000e1";
const pos = { x: 0, y: 0 };

function grafo(aplicarEm: string | undefined, lookup: Record<string, unknown> = {}, ordem: "antes" | "depois" = "antes") {
  const busca = {
    id: "neg",
    type: "find_or_create_lead",
    label: "Negócio",
    position: pos,
    config: { contato: "", pipeline_id: FUNIL, stage_id: ETAPA, titulo: "", criar: true, ...lookup },
  };
  const tag = {
    id: "tag",
    type: "edit_lead_tag",
    label: "Tag",
    position: pos,
    config: { tags: ["vip"], ...(aplicarEm === undefined ? {} : { aplicar_em: aplicarEm }) },
  };
  const [a, b] = ordem === "antes" ? [busca, tag] : [tag, busca];
  return flowGraphSchema.parse({
    nodes: [
      { id: "t", type: "trigger", label: "t", position: pos, config: {} },
      a,
      b,
      { id: "f", type: "end", label: "f", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "t", target: a.id, priority: 0, condition: { type: "always" } },
      { id: "e2", source: a.id, target: b.id, priority: 0, condition: { type: "always" } },
      { id: "e3", source: b.id, target: "f", priority: 0, condition: { type: "always" } },
    ],
  });
}

const codigos = (g: ReturnType<typeof grafo>) => {
  const r = validateFlowForPublish(g, {});
  return r.ok ? [] : r.errors.map((e) => e.code);
};

describe("buscar ou criar e «Aplicar em» na publicação", () => {
  it("aceita o negócio ou o contato de um Buscar ou criar anterior", () => {
    expect(codigos(grafo("{{nodes.neg.lead_id}}"))).toEqual([]);
    expect(codigos(grafo("{{nodes.neg.contact_id}}"))).toEqual([]);
    expect(codigos(grafo(undefined))).toEqual([]);
  });

  it("recusa marca que não é lead_id/contact_id, texto solto, e bloco que vem depois", () => {
    expect(codigos(grafo("{{nodes.neg.criado}}"))).toContain("aplicar_em_invalido");
    expect(codigos(grafo("negócio do João"))).toContain("aplicar_em_invalido");
    expect(codigos(grafo("{{nodes.neg.lead_id}}", {}, "depois")).length).toBeGreaterThan(0);
  });

  it("negócio exige funil; criar exige etapa", () => {
    expect(codigos(grafo(undefined, { pipeline_id: "" }))).toContain("negocio_sem_funil");
    expect(codigos(grafo(undefined, { stage_id: "" }))).toContain("negocio_sem_etapa");
    expect(codigos(grafo(undefined, { stage_id: "", criar: false }))).toEqual([]);
  });

  it("excluir o Buscar ou criar avisa quem o usa em «Aplicar em»", () => {
    expect(dependentesDoNo(grafo("{{nodes.neg.lead_id}}"), "neg").map((n) => n.id)).toEqual(["tag"]);
  });
});
