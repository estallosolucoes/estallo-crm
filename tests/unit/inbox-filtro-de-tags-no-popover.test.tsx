import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import type { ActiveOrg } from "@/lib/auth/types";

/**
 * O FILTRO DE ETIQUETAS NO POPOVER "Filtrar conversas" (redesenho, 16/10/2026).
 *
 * Substitui as suítes do menu de tags antigo (`inbox-filtro-de-tag-nao-desmonta`,
 * `seletor-de-tag-sobrevive-a-org-nula`, `inbox-busca-no-seletor-de-etiquetas`)
 * com as MESMAS garantias, agora no popover:
 *   - o seletor não desmonta quando o vocabulário oscila (indefinido/vazio);
 *   - organização sem etiqueta não ganha seletor morto;
 *   - filtro órfão (etiqueta que sumiu) mantém a válvula para desfazer (#1274);
 *   - a busca filtra o vocabulário JÁ carregado — digitar não muda o filtro;
 *   - duas etiquetas oferecem E/OU, e o "Aplicar" leva o modo.
 * O popover é um RASCUNHO: nada vale até "Aplicar filtros".
 */

const activeOrgRef: { current: ActiveOrg | null } = { current: null };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] as ChannelSession[] }) };
});
const vocab: { atual: string[] | undefined } = { atual: undefined };
let ultimo: { chave: string; valor: string[] | undefined } = { chave: "", valor: undefined };
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => {
    if (vocab.atual === undefined) return { data: undefined };
    const chave = JSON.stringify(vocab.atual);
    if (chave !== ultimo.chave) ultimo = { chave, valor: vocab.atual };
    return { data: ultimo.valor };
  },
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 3, all: 5 } }),
}));

const VALUE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };
const MUITAS = ["vip", "retorno", "quente", "frio", "lead", "cliente", "parceiro"];

function abrirFiltros() {
  fireEvent.click(screen.getByRole("button", { name: "Filtrar conversas" }));
}
const seletor = () => screen.queryByLabelText("Filtrar por tag");

beforeEach(() => {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  vocab.atual = ["retorno", "vip"];
});
afterEach(cleanup);

describe("o seletor de etiqueta sobrevive à oscilação do vocabulário", () => {
  it("com vocabulário, as etiquetas aparecem como caixas no popover", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    abrirFiltros();
    const caixa = seletor();
    expect(caixa).toBeInTheDocument();
    expect(within(caixa!).getByRole("checkbox", { name: /vip/ })).toBeInTheDocument();
    expect(within(caixa!).getByRole("checkbox", { name: /retorno/ })).toBeInTheDocument();
  });

  it("vocabulário voltando a INDEFINIDO ou VAZIO não derruba o seletor aberto", () => {
    const { rerender } = render(<InboxFilters value={VALUE} onChange={() => {}} />);
    abrirFiltros();
    vocab.atual = undefined;
    rerender(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(within(seletor()!).getByRole("checkbox", { name: /vip/ })).toBeInTheDocument();
    vocab.atual = [];
    rerender(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(within(seletor()!).getByRole("checkbox", { name: /vip/ })).toBeInTheDocument();
  });

  it("organização que nunca teve etiqueta não ganha seletor morto", () => {
    vocab.atual = [];
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    abrirFiltros();
    expect(seletor()).toBeNull();
  });

  it("vocabulário em voo, sem nada conhecido ainda, também não desenha o seletor", () => {
    vocab.atual = undefined;
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    abrirFiltros();
    expect(seletor()).toBeNull();
  });
});

describe("filtro órfão mantém a válvula (#1274)", () => {
  it("uma etiqueta que sumiu do vocabulário continua no seletor, marcada", () => {
    vocab.atual = ["vip"];
    render(<InboxFilters value={{ ...VALUE, tag: "apagada" }} onChange={() => {}} />);
    abrirFiltros();
    expect(within(seletor()!).getByRole("checkbox", { name: /apagada/ })).toBeChecked();
  });

  it("DUAS etiquetas órfãs também aparecem", () => {
    vocab.atual = [];
    render(<InboxFilters value={{ ...VALUE, tag: ["x1", "x2"] }} onChange={() => {}} />);
    abrirFiltros();
    expect(within(seletor()!).getByRole("checkbox", { name: /x1/ })).toBeInTheDocument();
    expect(within(seletor()!).getByRole("checkbox", { name: /x2/ })).toBeInTheDocument();
  });

  it("e o chip do filtro ativo também desfaz a órfã", () => {
    const onChange = vi.fn();
    vocab.atual = [];
    render(<InboxFilters value={{ ...VALUE, tag: "apagada" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover filtro: apagada" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tag: undefined }));
  });
});

describe("a busca dentro do seletor e o E/OU", () => {
  it("a busca filtra o vocabulário carregado — e digitar não muda o filtro", () => {
    vocab.atual = MUITAS;
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    abrirFiltros();
    fireEvent.change(screen.getByLabelText("Buscar etiqueta"), { target: { value: "qu" } });
    const caixa = seletor()!;
    expect(within(caixa).getByRole("checkbox", { name: /quente/ })).toBeInTheDocument();
    expect(within(caixa).queryByRole("checkbox", { name: /vip/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("escolher duas, buscar e limpar a busca: as duas seguem marcadas; o OU vai no Aplicar", () => {
    vocab.atual = MUITAS;
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    abrirFiltros();
    fireEvent.click(within(seletor()!).getByRole("checkbox", { name: /vip/ }));
    fireEvent.click(within(seletor()!).getByRole("checkbox", { name: /retorno/ }));
    const busca = screen.getByLabelText("Buscar etiqueta");
    fireEvent.change(busca, { target: { value: "qu" } });
    fireEvent.change(busca, { target: { value: "" } });
    expect(within(seletor()!).getByRole("checkbox", { name: /vip/ })).toBeChecked();
    expect(within(seletor()!).getByRole("checkbox", { name: /retorno/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Combinar tags"), { target: { value: "ou" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tag: ["vip", "retorno"], tagMode: "ou" }),
    );
  });

  it("com uma etiqueta só, não há E/OU (o modo não muda nada)", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    abrirFiltros();
    fireEvent.click(within(seletor()!).getByRole("checkbox", { name: /vip/ }));
    expect(screen.queryByLabelText("Combinar tags")).toBeNull();
  });
});
