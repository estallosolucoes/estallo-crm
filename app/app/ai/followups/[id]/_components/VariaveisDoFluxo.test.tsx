import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "@/lib/followup/graph-schema";

import { gruposDeVariaveis, inserirNoCursor } from "./VariaveisDoFluxo";

const no = (id: string, type: string, label: string, config: unknown) => ({ id, type, label, position: { x: 0, y: 0 }, config });
const grafo = flowGraphSchema.parse({
  nodes: [
    no("t", "trigger", "Início", {}),
    no("tag", "edit_lead_tag", "Etiqueta Cliente", { tags: ["Cliente"] }),
    no("m", "action", "Mensagem", { mode: "text", body: "oi" }),
    no("outro", "edit_lead_tag", "Etiqueta de outro ramo", { tags: ["x"] }),
    no("f", "end", "Fim", { outcome: "converted" }),
  ],
  edges: [
    { id: "e1", source: "t", target: "tag", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "tag", target: "m", priority: 0, condition: { type: "always" } },
    { id: "e3", source: "m", target: "f", priority: 0, condition: { type: "always" } },
    { id: "e4", source: "outro", target: "f", priority: 0, condition: { type: "always" } },
  ],
});

describe("gruposDeVariaveis", () => {
  it("oferece o contato e, dos blocos ANTERIORES, só os que declaram saída — com o nome que a pessoa deu", () => {
    const grupos = gruposDeVariaveis(grafo, "m");
    expect(grupos.map((g) => g.rotulo)).toEqual(["Contato e negócio", "Início", "Etiqueta Cliente"]);
    expect(grupos[2]!.itens.map((i) => i.marca)).toEqual(["{{nodes.tag.tags}}", "{{nodes.tag.added_tags}}"]);
  });

  it("não oferece o próprio bloco, nem bloco de outro ramo, nem bloco sem saída útil", () => {
    const marcas = gruposDeVariaveis(grafo, "m").flatMap((g) => g.itens.map((i) => i.marca));
    expect(marcas.some((m) => m.includes("nodes.m."))).toBe(false);
    expect(marcas.some((m) => m.includes("nodes.outro."))).toBe(false);
  });

  it("sem grafo ou sem bloco aberto, só o contato", () => {
    expect(gruposDeVariaveis(null, null)).toHaveLength(1);
    expect(gruposDeVariaveis(grafo, null)).toHaveLength(1);
  });
});

describe("inserirNoCursor", () => {
  it("entra no cursor, substitui a seleção, e vai ao fim sem campo", () => {
    const campo = { selectionStart: 3, selectionEnd: 3 } as HTMLTextAreaElement;
    expect(inserirNoCursor(campo, "Oi !", "{{nome}}")).toBe("Oi {{nome}}!");
    expect(inserirNoCursor({ selectionStart: 0, selectionEnd: 2 } as HTMLTextAreaElement, "Oi x", "{{nome}}")).toBe("{{nome}} x");
    expect(inserirNoCursor(null, "Oi", " {{nome}}")).toBe("Oi {{nome}}");
  });
});

describe("PreviaDoTexto", () => {
  it("mostra o texto com a amostra, rotulada como exemplo, e avisa a variável sem valor", async () => {
    const { PreviaDoTexto } = await import("./VariaveisDoFluxo");
    render(<PreviaDoTexto texto="Oi {{primeiro_nome}} {{apelido}}!" />);
    expect(screen.getByTestId("previa-do-texto")).toHaveTextContent("Como vai sair (exemplo simulado)");
    expect(screen.getByTestId("previa-do-texto")).toHaveTextContent("Oi Maria!");
    expect(screen.getByTestId("previa-sem-valor")).toHaveTextContent("{{apelido}}");
  });
  it("sem variável no texto, não aparece", async () => {
    const { PreviaDoTexto } = await import("./VariaveisDoFluxo");
    render(<PreviaDoTexto texto="Oi!" />);
    expect(screen.queryByTestId("previa-do-texto")).toBeNull();
  });
});
