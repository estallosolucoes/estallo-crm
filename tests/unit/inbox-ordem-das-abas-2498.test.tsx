/** Categorias do Inbox na ordem solicitada em 16/10/2026, com contadores próprios e RLS. */
import { readFileSync } from "node:fs";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, visibleInboxTabs, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const activeOrgRef: { current: ActiveOrg | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
// Uma contagem POR ABA, para o caso de contadores poder acusar uma troca de
// chave: `automatico` é a da "Automático", `fila` é a da "Fila".
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({
    data: { em_aberto: 3, mine: 9, pendentes: 2, all: 5, em_espera: 7, closed: 4, archived: 1 },
  }),
}));

const VALUE: InboxFiltersValue = { tab: "all", search: "", onlyUnread: false };

/** O rótulo de cada aba, sem o contador que vem colado no `textContent`. */
function abasRenderizadas(): string[] {
  return screen
    .getAllByRole("tab")
    .map((el) => (el.textContent ?? "").replace(/\d+$/, "").trim());
}

beforeEach(() => {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
});
afterEach(cleanup);

describe("as cinco categorias do atendimento", () => {
  // 16/10/2026: a ordem do MODELO do Inbox do dono substitui a da #2498 —
  // Fila primeiro, Automático depois de Pendentes. Valores e contadores iguais.
  it("Todas, Sem resposta, Em espera, Em aberto, Fechadas — nessa ordem", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(abasRenderizadas()).toEqual([
      "Todas",
      "Sem resposta",
      "Em espera",
      "Em aberto",
      "Fechadas",
    ]);
  });

  it("os VALUES e os rótulos são os MESMOS de antes, só reordenados", () => {
    // Pares lidos da FONTE, e não da tela: `value` é o que a rota recebe
    // (`?filter=ai`) e nenhum deles é exposto como atributo no `TabsTrigger`.
    // Um par trocado de rótulo nasceria um filtro que a rota não lê, e um par
    // a mais nasceria uma aba que ninguém tem contador — por isso os 6, um por
    // um, na ordem nova.
    const fonte = readFileSync("components/inbox/InboxFilters.tsx", "utf8");
    const pares = [...fonte.matchAll(/\{\s*value:\s*"(\w+)",\s*label:\s*"([^"]+)"\s*\}/g)].map(
      ([, value, label]) => `${value}=${label}`,
    );
    expect(pares).toEqual([
      "all=Todas",
      "pending=Sem resposta",
      "waiting=Em espera",
      "open=Em aberto",
      "closed=Fechadas",
    ]);
  });

  it("cada aba continua com o SEU contador (nada trocou de chave)", () => {
    render(<InboxFilters value={VALUE} onChange={() => {}} />);
    expect(screen.getByRole("tab", { name: /^Em espera/ })).toHaveTextContent("7");
    expect(screen.getByRole("tab", { name: /^Em aberto/ })).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: /^Sem resposta/ })).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /^Todas/ })).toHaveTextContent("5");
    expect(screen.getByRole("tab", { name: /^Fechadas/ })).toHaveTextContent("4");
  });
});

describe("só a ordem muda — as permissões continuam quem eram", () => {
  it("manager vê as seis, com 'Todas' no meio", () => {
    expect(visibleInboxTabs("manager", "all")).toEqual([
      "all",
      "pending",
      "waiting",
      "open",
      "closed",
    ]);
  });

  it("agent em modo own* vê as mesmas abas, na mesma ordem (Minhas virou filtro)", () => {
    // Sem a aba "Minhas", 'Todas' (recortada pela RLS) é a caixa do agent.
    expect(visibleInboxTabs("agent", "own")).toEqual([
      "all",
      "pending",
      "waiting",
      "open",
      "closed",
    ]);
  });

  it("agent com visibility 'all' tem as seis, 'Todas' na posição dela", () => {
    expect(visibleInboxTabs("agent", "all")).toEqual([
      "all",
      "pending",
      "waiting",
      "open",
      "closed",
    ]);
  });

  it("a aba ativa continua podendo ser QUALQUER uma das seis", () => {
    // A faixa é navegável por seta (`moveTab` anda pelo array): uma ordem nova
    // que embaralhasse os índices devolveria o operador à vizinha errada.
    render(<InboxFilters value={{ ...VALUE, tab: "closed" }} onChange={() => {}} />);
    const ativa = screen.getByRole("tab", { selected: true });
    expect(ativa.textContent ?? "").toMatch(/^Fechadas/);
  });
});

it("a ajuda abre descrições curtas dos cinco status", () => {
  render(<InboxFilters value={VALUE} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "O que significa cada status do chat?" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Primeiro contato: ainda não recebeu nenhuma resposta.");
  expect(screen.getByRole("dialog")).toHaveTextContent("Já foi respondido e escreveu novamente.");
});
it("escolher a ordem só a aplica ao confirmar o filtro", () => {
  const onChange = vi.fn();
  render(<InboxFilters value={VALUE} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Filtrar conversas" }));
  fireEvent.change(screen.getByLabelText("Ordem"), { target: { value: "antigo" } });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ordem: "antigo" }));
});
