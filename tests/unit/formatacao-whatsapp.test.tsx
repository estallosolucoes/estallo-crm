import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  analisarBlocos,
  analisarInline,
  FormatacaoWhatsApp,
} from "@/lib/mensagens/formatacao-whatsapp";

/** O HTML que o componente produz, para comparar a estrutura de verdade. */
function html(texto: string, modo?: "bloco" | "linha"): string {
  const { container } = render(<FormatacaoWhatsApp texto={texto} modo={modo} />);
  return container.innerHTML;
}

describe("formatação do WhatsApp — inline", () => {
  it("negrito, itálico e tachado somem os marcadores", () => {
    expect(html("Seu pedido *foi aprovado* e chega _amanhã_ ~ontem~")).toBe(
      'Seu pedido <strong class="font-bold">foi aprovado</strong> e chega <em>amanhã</em> <s>ontem</s>',
    );
  });

  it("combinação aninhada", () => {
    expect(html("*_urgente_*")).toBe('<strong class="font-bold"><em>urgente</em></strong>');
  });

  it("símbolo no meio de palavra ou número não vira estilo", () => {
    expect(analisarInline("2*3*4 = 24")).toEqual(["2*3*4 = 24"]);
    expect(analisarInline("snake_case_var")).toEqual(["snake_case_var"]);
    expect(analisarInline("a * b * c")).toEqual(["a * b * c"]);
  });

  it("marcador sem fechamento fica literal", () => {
    expect(analisarInline("*oi")).toEqual(["*oi"]);
    expect(analisarInline("_tchau")).toEqual(["_tchau"]);
  });

  it("estilo não atravessa a quebra de linha", () => {
    expect(html("*oi\ntudo*")).toBe("*oi\ntudo*");
  });

  it("código inline e monoespaçado são literais por dentro", () => {
    expect(analisarInline("use `*nao*` aqui")).toEqual([
      "use ",
      { tipo: "codigo", texto: "*nao*" },
      " aqui",
    ]);
    expect(analisarInline("```a_b_c```")).toEqual([{ tipo: "mono", texto: "a_b_c" }]);
  });

  it("URL é atômica: o _ dela não vira itálico, e ela vira link seguro", () => {
    const saida = html("veja https://ex.com/a_b_c ok");
    expect(saida).toContain('href="https://ex.com/a_b_c"');
    expect(saida).toContain('rel="noopener noreferrer"');
    expect(saida).not.toContain("<em>");
  });

  it("HTML do cliente é texto, nunca marcação", () => {
    const saida = html("<script>alert(1)</script> *oi*");
    expect(saida).not.toContain("<script>");
    expect(saida).toContain("&lt;script&gt;");
  });

  it("emoji e acentos passam intactos", () => {
    expect(html("Olá 👋 *ação*")).toBe('Olá 👋 <strong class="font-bold">ação</strong>');
  });
});

describe("formatação do WhatsApp — blocos", () => {
  it("citação, lista e lista numerada", () => {
    expect(analisarBlocos("> citado\n- um\n- dois\n1. a\n2. b").map((b) => b.tipo)).toEqual([
      "citacao",
      "lista",
      "lista",
    ]);
    const saida = html("> citado\n- um\n- dois");
    expect(saida).toContain("<blockquote");
    expect(saida).toContain("<ul");
    expect(saida).toContain("<li>um</li>");
  });

  it("monoespaçado de várias linhas vira bloco", () => {
    const blocos = analisarBlocos("antes\n```linha 1\nlinha 2```\ndepois");
    expect(blocos.map((b) => b.tipo)).toEqual(["texto", "mono", "texto"]);
  });

  it("texto comum preserva as quebras de linha", () => {
    expect(html("oi\n\ntudo bem?")).toBe("oi\n\ntudo bem?");
  });

  it("no modo linha (prévia), os blocos são achatados e não há link", () => {
    const saida = html("> *oi*\n- item https://ex.com", "linha");
    expect(saida).toBe('<strong class="font-bold">oi</strong> • item https://ex.com');
  });
});
