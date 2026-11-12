/**
 * A paleta oferece só as caixas que o motor da superfície executa — na prova
 * prática do #1130, a paleta do roteiro oferecia seis caixas (Aguardar,
 * Condição, Classificar…) que o motor recusava em silêncio.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NodePalette } from "./NodePalette";

const tipos = () =>
  screen.getAllByRole("button").map((b) => b.getAttribute("data-testid")?.replace("palette-add-", ""));

describe("NodePalette por superfície", () => {
  it("roteiro: Início, Pergunta, Skill e Fim", () => {
    render(<NodePalette onAdd={() => {}} surface="atendimento" />);
    // A ordem segue as categorias da paleta; o que importa aqui é o CONJUNTO oferecido.
    expect([...tipos()].sort()).toEqual(["collect", "end", "skill", "trigger"]);
  });

  it("follow-up: sem Pergunta nem Skill", () => {
    render(<NodePalette onAdd={() => {}} />);
    expect(tipos()).not.toContain("collect");
    expect(tipos()).not.toContain("skill");
    expect(tipos()).toContain("wait");
  });

  it("busca por sinônimo filtra os blocos; sem resultado, diz que não achou", () => {
    render(<NodePalette onAdd={() => {}} />);
    fireEvent.change(screen.getByTestId("palette-busca"), { target: { value: "vendedor" } });
    expect(tipos()).toContain("assign_lead_owner");
    expect(tipos()).not.toContain("wait");
    fireEvent.change(screen.getByTestId("palette-busca"), { target: { value: "zzzz" } });
    expect(screen.getByTestId("palette-vazia")).toBeInTheDocument();
  });

  it("agrupa por categoria em seções recolhíveis", () => {
    render(<NodePalette onAdd={() => {}} />);
    const leads = screen.getByTestId("palette-categoria-leads");
    expect(leads.tagName).toBe("DETAILS");
    expect(leads.querySelector("[data-testid=palette-add-move_lead]")).not.toBeNull();
  });
});
