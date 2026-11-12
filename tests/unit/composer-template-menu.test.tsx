import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { filtrarTemplates, resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";

describe("resolveSlash", () => {
  it("abre com / no início e captura o query", () => {
    expect(resolveSlash("/fech")).toEqual({ open: true, query: "fech" });
    expect(resolveSlash("/")).toEqual({ open: true, query: "" });
  });
  it("o espaço NÃO fecha: nome composto continua buscável", () => {
    expect(resolveSlash("/fech agora")).toEqual({ open: true, query: "fech agora" });
    expect(resolveSlash("/Boas vindas")).toEqual({ open: true, query: "Boas vindas" });
  });
  it("não abre sem / no início, e a quebra de linha encerra a busca", () => {
    expect(resolveSlash("oi")).toEqual({ open: false, query: "" });
    expect(resolveSlash("/boas\nvindas").open).toBe(false);
  });
});

describe("filtrarTemplates", () => {
  const lista = [
    { id: "1", title: "Boas vindas", body: "Olá!", shortcut: null, owner_user_id: null },
    { id: "2", title: "Boas festas", body: "Feliz natal", shortcut: "natal", owner_user_id: null },
    { id: "3", title: "Promoção", body: "Desconto", shortcut: "promo", owner_user_id: null },
  ];
  const ids = (q: string) => filtrarTemplates(lista, q).map((t) => t.id);

  it("acha nome composto depois do espaço (o defeito relatado)", () => {
    expect(ids("Boas ")).toEqual(["1", "2"]);
    expect(ids("Boas vindas")).toEqual(["1"]);
  });
  it("ignora maiúsculas, acentos e espaços sobrando", () => {
    expect(ids("  boas   VINDAS ")).toEqual(["1"]);
    expect(ids("promocao")).toEqual(["3"]);
  });
  it("casa pelo atalho também, e termo vazio devolve tudo", () => {
    expect(ids("natal")).toEqual(["2"]);
    expect(ids("")).toEqual(["1", "2", "3"]);
  });
});

describe("TemplateMenu", () => {
  const templates = [
    { id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}", shortcut: "oi" },
    { id: "2", title: "Fechamento", body: "Fechado!", shortcut: "fech" },
  ];
  it("devolve o escolhido no clique", () => {
    const onPick = vi.fn();
    const opcoes = filtrarTemplates(templates as never, "fech");
    render(<TemplateMenu open opcoes={opcoes} indice={0} onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Fechamento"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });
  it("marca a opção do índice como selecionada", () => {
    render(<TemplateMenu open opcoes={templates as never} indice={1} onPick={() => {}} onClose={() => {}} />);
    const opcoes = screen.getAllByRole("option");
    expect(opcoes[0]).toHaveAttribute("aria-selected", "false");
    expect(opcoes[1]).toHaveAttribute("aria-selected", "true");
  });
});
