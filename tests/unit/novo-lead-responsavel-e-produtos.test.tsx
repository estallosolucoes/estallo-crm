import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as renderSemQuery, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Stage } from "@/lib/kanban/types";

/**
 * "Novo Lead" (Inbox e quadro): o responsável nasce como quem cria, pode ser
 * trocado ou tirado, e os produtos escolhidos entram no negócio pela MESMA rota
 * do dossiê (`/leads/[id]/produtos`) depois de ele existir.
 */

const EU = "0b000000-0000-4000-8000-0000000000aa";
const GABRIEL = "0b000000-0000-4000-8000-0000000000bb";
const PRODUTO = "0c000000-0000-4000-8000-000000000001";
const CONTATO = "22222222-2222-4222-8222-222222222222";

const criarLead = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/kanban/useCreateLead", () => ({
  useCreateLead: () => ({ mutateAsync: criarLead, isPending: false }),
}));
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({ data: { pages: [{ data: [] }] }, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({
    data: [
      { user_id: EU, role: "agent", full_name: "Wilson" },
      { user_id: GABRIEL, role: "agent", full_name: "Gabriel" },
    ],
  }),
}));
vi.mock("@/hooks/leads/useProdutosDoNegocio", () => ({
  useCatalogoDeProdutos: () => ({
    data: [{ id: PRODUTO, nome: "Coleta na Prática VCA", preco_cents: 19700, ativo: true }],
  }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post, get: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
  useAuth: () => ({ activeOrg: { orgId: "org-1" } }),
  useUser: () => ({ id: EU, full_name: "Wilson" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

// O diálogo lê a cache do react-query (seletor de tags, quadro a reler).
function ComQuery({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: React.ReactElement) => renderSemQuery(ui, { wrapper: ComQuery });

const ETAPAS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Novo",
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
] as unknown as Stage[];

function abrir() {
  return render(
    <NewLeadDialog
      open
      onOpenChange={() => {}}
      pipelineId="33333333-3333-4333-8333-333333333333"
      stages={ETAPAS}
      contactId={CONTATO}
    />,
  );
}

// O `Select` do Radix usa a captura de ponteiro e o `scrollIntoView`, que o jsdom não tem.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  criarLead.mockReset();
  criarLead.mockResolvedValue({ data: { id: "44444444-4444-4444-8444-444444444444" } });
  post.mockReset();
  post.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("Novo Lead — responsável e produtos", () => {
  it("sem mexer em nada, o responsável é quem está criando", async () => {
    const user = userEvent.setup();
    abrir();
    expect(screen.getByTestId("novo-lead-responsavel").textContent).toContain("Wilson");

    await user.type(screen.getByLabelText("Título"), "Coleta VCA");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ owner_user_id: EU, contact_id: CONTATO });
    // Sem produto escolhido, nenhuma escrita extra.
    expect(post).not.toHaveBeenCalled();
  });

  it("trocar o responsável e escolher um produto: o lead nasce com os dois", async () => {
    const user = userEvent.setup();
    abrir();

    await user.click(screen.getByTestId("novo-lead-responsavel"));
    await user.click(await screen.findByRole("option", { name: /Gabriel/ }));
    await user.click(screen.getByTestId("novo-lead-adicionar-produto"));
    await user.click(await screen.findByRole("option", { name: /Coleta na Prática VCA/ }));
    expect(screen.getByTestId("novo-lead-produtos").textContent).toContain("Coleta na Prática VCA");
    // O valor vira a soma NA HORA, e deixa de ser digitável.
    const valor = screen.getByTestId("novo-lead-valor-pelos-produtos") as HTMLInputElement;
    expect(valor.value).toMatch(/197,00/);
    expect(valor.readOnly).toBe(true);

    // Desconto por produto, como no dossiê: a soma acompanha.
    // Máscara de dinheiro: 2000 → 20,00.
    await user.type(screen.getByLabelText("Desconto"), "2000");
    await user.tab();
    expect(valor.value).toMatch(/177,00/);

    await user.type(screen.getByLabelText("Título"), "Coleta VCA");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ owner_user_id: GABRIEL });
    // Com produtos o valor é da trigger: o campo não viaja.
    expect(criarLead.mock.calls[0]?.[0]).not.toHaveProperty("value_cents");
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/leads/44444444-4444-4444-8444-444444444444/produtos",
        {
          product_id: PRODUTO,
          desconto_cents: 2000,
        },
      ),
    );
  });

  it("tags pelo mesmo seletor do dossiê: criar uma na hora entra no lead", async () => {
    const user = userEvent.setup();
    abrir();
    expect(screen.queryByText("Tags (separadas por vírgula)")).toBeNull();

    await user.type(screen.getByLabelText("Tags da oportunidade"), "vip{Enter}");
    await user.type(screen.getByLabelText("Título"), "Com tag");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ tags: ["vip"] });
  });

  it("'Sem responsável' cria o lead sem dono", async () => {
    const user = userEvent.setup();
    abrir();

    await user.click(screen.getByTestId("novo-lead-responsavel"));
    await user.click(await screen.findByRole("option", { name: "Sem responsável" }));
    await user.type(screen.getByLabelText("Título"), "Sem dono");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
    expect(criarLead.mock.calls[0]?.[0]).not.toHaveProperty("owner_user_id");
  });
});

it("adicionar pela etapa respeita a etapa pré-selecionada na criação", async () => {
  const user = userEvent.setup();
  const etapa = { ...ETAPAS[0]!, id: "11111111-1111-4111-8111-111111111112", name: "Proposta" };
  render(<NewLeadDialog open onOpenChange={() => {}} pipelineId="33333333-3333-4333-8333-333333333333" stages={[...ETAPAS, etapa]} initialStageId={etapa.id} contactId={CONTATO} />);
  await user.type(screen.getByLabelText("Título"), "Lead na etapa escolhida");
  await user.click(screen.getByRole("button", { name: "Criar lead" }));
  await waitFor(() => expect(criarLead).toHaveBeenCalledTimes(1));
  expect(criarLead.mock.calls[0]?.[0]).toMatchObject({ stage_id: etapa.id });
});
