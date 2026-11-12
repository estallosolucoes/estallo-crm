import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (text: string) => traduzir(text, "pt-BR") };
});

import { SaidaDoBloco } from "./SaidaDoBloco";

const no = (type: string, config: unknown) => ({ id: "b1", type, label: "Bloco", position: { x: 0, y: 0 }, config }) as never;

describe("SaidaDoBloco — contrato declarado × exemplo simulado", () => {
  it("lista o contrato com a marca exata e mostra o exemplo com rótulo de exemplo, nunca de execução", () => {
    render(<SaidaDoBloco no={no("internal_task", {})} />);
    const contrato = screen.getByTestId("saida-contrato");
    expect(within(contrato).getByText("{{nodes.b1.task_id}}")).toBeInTheDocument();
    const dados = screen.getByTestId("dados-inspecionados");
    expect(dados).toHaveAttribute("data-origem", "exemplo");
    expect(within(dados).getByText("Exemplo simulado")).toBeInTheDocument();
    expect(screen.queryByText("Valor desta execução")).toBeNull();
  });

  it("Mapear dados declara os campos configurados como fields.<nome>", () => {
    render(<SaidaDoBloco no={no("map_data", { fields: [{ name: "valor_total", value: "1", type: "number" }] })} />);
    expect(screen.getByText("{{nodes.b1.fields.valor_total}}")).toBeInTheDocument();
  });

  it("bloco que não entrega campo não mostra a seção", () => {
    render(<SaidaDoBloco no={no("wait", { mode: "fixed", duration_ms: 1000 })} />);
    expect(screen.queryByTestId("saida-do-bloco")).toBeNull();
  });
});
