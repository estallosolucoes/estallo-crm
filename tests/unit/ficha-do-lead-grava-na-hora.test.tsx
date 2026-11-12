import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadDossierDoFunil } from "@/components/kanban/LeadDossierDoFunil";
import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";
import type { ItemDoRascunho } from "@/lib/leads/rascunho-de-produtos";

/**
 * A ficha do lead GRAVA NA HORA (30/10/2026) — antes era um rascunho com
 * "Salvar" no pé, e a operação reclamava que produto, tag e campo demoravam a
 * "pegar". Cada ação muda a tela antes do servidor responder; erro desfaz e
 * avisa. O dossiê aberto pelo Inbox continua abrindo na hora.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
const avisos = vi.hoisted(() => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => avisos);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent" }),
  useAuth: () => ({ activeOrg: { orgId: "org-1" } }),
  useUser: () => ({ id: "u-1", is_platform_admin: false, support: null }),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  chaveDoQuadro: (id: string | null) => ["board", id],
  useBoard: () => ({ data: undefined }),
  useQuadroDoLead: () => ({ data: undefined, isError: false, refetch: () => {}, isFetching: true }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

const LEAD = "a0000000-0000-4000-8000-000000000001";
const PRODUTO = "0c000000-0000-4000-8000-000000000001";
const GRAVADO: ItemDoRascunho = {
  id: "i-1",
  product_id: "0c000000-0000-4000-8000-000000000009",
  nome: "Coleta",
  quantidade: 1,
  preco_unitario_cents: 5000,
  desconto_cents: 0,
};
const NEGOCIO = {
  id: LEAD,
  title: "Negócio",
  description: null,
  value_cents: 5000,
  currency: "BRL",
  stage_id: "22222222-2222-4222-8222-222222222222",
  expected_close_date: null,
  tags: [],
  custom_fields: {},
} as never;

function comQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/produtos")) return { data: [{ ...GRAVADO, lead_id: LEAD, created_at: "" }] };
    if (url === "/api/v1/products")
      return { data: [{ id: PRODUTO, nome: "Coleta VCA", preco_cents: 19700, ativo: true }] };
    return { data: [] };
  });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: NEGOCIO });
  api.delete.mockResolvedValue({ data: {} });
});
afterEach(() => vi.clearAllMocks());

describe("ficha do lead — cada ação grava na hora", () => {
  it("adicionar produto aparece antes do servidor responder e grava sem botão", async () => {
    let responder: (v: unknown) => void = () => {};
    api.post.mockImplementation(() => new Promise((r) => (responder = r)));
    const user = userEvent.setup();
    comQuery(<LeadFieldsForm lead={NEGOCIO} pipelineId="p-1" />);
    await screen.findByText("Coleta");

    await user.click(screen.getByTestId("adicionar-produto"));
    await user.click(await screen.findByRole("option", { name: /Coleta VCA/ }));

    // Na tela já, com o servidor ainda pensando.
    expect(screen.getByText("Coleta VCA")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/produtos`, {
      product_id: PRODUTO,
      quantidade: 1,
      desconto_cents: 0,
    });
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    responder({ data: {} });
  });

  it("remover produto que o servidor recusa volta para a tela e avisa", async () => {
    api.delete.mockRejectedValue(new Error("recusado"));
    const user = userEvent.setup();
    comQuery(<LeadFieldsForm lead={NEGOCIO} pipelineId="p-1" />);
    await screen.findByText("Coleta");

    await user.click(screen.getByRole("button", { name: "Remover produto: Coleta" }));

    await waitFor(() => expect(avisos.showApiError).toHaveBeenCalled());
    expect(await screen.findByText("Coleta")).toBeTruthy();
  });

  it("título grava ao sair do campo, só com o que mudou", async () => {
    const user = userEvent.setup();
    comQuery(<LeadFieldsForm lead={NEGOCIO} pipelineId="p-1" />);
    await screen.findByText("Coleta");

    await user.type(screen.getByLabelText("Título"), " editado");
    expect(api.patch).not.toHaveBeenCalled();
    await user.tab();

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]?.[1]).toEqual({ title: "Negócio editado" });
  });

  it("título que o servidor recusa volta ao valor anterior", async () => {
    api.patch.mockRejectedValue(new Error("recusado"));
    const user = userEvent.setup();
    comQuery(<LeadFieldsForm lead={NEGOCIO} pipelineId="p-1" />);
    await screen.findByText("Coleta");

    await user.type(screen.getByLabelText("Título"), " editado");
    await user.tab();

    await waitFor(() => expect((screen.getByLabelText("Título") as HTMLInputElement).value).toBe("Negócio"));
  });
});

describe("dossiê pelo Inbox — abre na hora", () => {
  it("a gaveta abre com o título antes de o quadro do funil chegar", () => {
    comQuery(
      <LeadDossierDoFunil
        pipelineId="p-1"
        leadId={LEAD}
        titulo="Coleta · Marina"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain("Coleta · Marina");
    expect(screen.getByTestId("dossie-carregando")).toBeTruthy();
  });
});
