/** As cinco categorias preservam os rótulos e navegam sem sobreposição. A geometria é medida no browser. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  InboxFilters,
  visibleInboxTabs,
  type InboxFiltersValue,
} from "@/components/inbox/InboxFilters";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  channelLabel: (c: { display_name: string }) => c.display_name,
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
// Contagens de 2 dígitos, como numa instalação viva: elas ALARGAM a aba, e é
// com elas que o corte foi medido.
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: {
      em_aberto: 47,
      em_espera: 12,
      mine: 8,
      pendentes: 8,
      all: 130,
      closed: 25,
      archived: 9,
    },
  }),
}));

const VALUE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };

afterEach(cleanup);

function faixa(): HTMLElement {
  const list = screen.getByRole("tablist");
  expect(list, "a faixa de abas não renderizou").toBeTruthy();
  return list;
}

describe("faixa da Inbox — categorias sem sobreposição", () => {
  // Rótulos preservam sua largura; o piso da lista protege o desktop.
  // No celular e com zoom alto, a faixa permite rolagem horizontal.
  it("a faixa é a do modelo — as abas dividem a largura em vez de quebrar linha", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(faixa().className.split(/\s+/)).toContain("ibx-categories");
    for (const aba of screen.getAllByRole("tab")) {
      expect(aba.className.split(/\s+/)).toContain("ibx-category");
    }
  });

  it("as cinco abas estão na faixa, com os rótulos inteiros", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // Guarda de vacuidade do caso acima e defesa do outro lado do defeito:
    // a saída fácil para \"não cabe\" é encurtar rótulo ou tirar aba, e aí a
    // catraca de classe continua verde com a tela errada.
    const abas = screen.getAllByRole("tab");
    expect(abas).toHaveLength(5);
    for (const rotulo of ["Todas", "Sem resposta", "Em espera", "Em aberto", "Fechadas"]) {
      expect(
        screen.getByRole("tab", { name: new RegExp(rotulo) }),
        `a aba "${rotulo}" não está na faixa`,
      ).toBeInTheDocument();
    }
  });

  it("quebrar a linha não muda o FILTRO: clicar em Fechadas manda tab=closed", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    // A quebra é de layout; o valor continua o MESMO contrato de antes.
    // O Radix `TabsTrigger` aciona no `mousedown`, não no `click`.
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Fechadas/ }));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, tab: "closed" });
  });

  it("a ordem é a do modelo (16/10/2026) e os valores não mudaram", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    // `visibleInboxTabs` é a fonte da ORDEM do trabalho; a largura não se paga
    // reordenando nem renomeando.
    expect(visibleInboxTabs("manager", "all")).toEqual([
      "all",
      "pending",
      "waiting",
      "open",
      "closed",
    ]);
    expect(screen.getAllByRole("tab").map((a) => a.textContent?.replace(/\s+/g, ""))).toEqual([
      "Todas130",
      "Semresposta8",
      "Emespera12",
      "Emaberto47",
      "Fechadas25",
    ]);
  });
});
