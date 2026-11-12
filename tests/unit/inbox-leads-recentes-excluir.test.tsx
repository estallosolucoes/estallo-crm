import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * "Leads recentes" no painel do Inbox: os três pontos de TODO negócio (ganho e
 * perdido inclusive) oferecem "Excluir lead", que só apaga depois da
 * confirmação — e apaga pela MESMA rota do card do quadro (`/leads/bulk`).
 */

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const LEAD_GANHO = "a0000000-0000-4000-8000-000000000002";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Marina", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get, post, patch: vi.fn() } }));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", role: "agent", capacidades_ligadas: [] },
  }),
  useActiveOrg: () => ({ currency: "BRL", country: null }),
  useUser: () => ({ id: "0b000000-0000-4000-8000-0000000000aa", full_name: null }),
}));

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: { updated_count: 1 } });
  get.mockImplementation(async (url: string) => (!url.includes("crm-summary") ? { data: [] } : {
    data: {
      leads: [
        {
          id: LEAD_GANHO, title: "CNPJ · Ateliê Marina", status: "won", value_cents: 17700,
          currency: "BRL", updated_at: "2026-10-15T12:00:00Z", pipeline_id: "p-1",
          custom_fields: {}, field_defs: [], funil_nome: "Funil de Vendas", etapa_nome: "Ganhos",
        },
      ],
      orders: [], activities: [], demandas: [], fatos: [], historico: [],
    },
  }));
});

describe("Leads recentes — excluir pelo próprio card", () => {
  it("lead ganho tem os três pontos, e excluir só acontece depois de confirmar", async () => {
    const user = userEvent.setup();
    renderPainel();

    await user.click(await screen.findByTestId(`inbox-lead-acoes-${LEAD_GANHO}`));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir lead" }));

    const janela = await screen.findByTestId("inbox-lead-excluir-confirmacao");
    expect(janela.textContent).toContain("Excluir lead?");
    expect(janela.textContent).toContain("CNPJ · Ateliê Marina");
    expect(janela.textContent).toContain("O contato e as conversas continuam disponíveis.");
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Excluir lead" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/leads/bulk", {
      action: "delete",
      lead_ids: [LEAD_GANHO],
      params: {},
    });
    await waitFor(() => expect(screen.queryByTestId("inbox-lead-excluir-confirmacao")).toBeNull());
  });

  it("'Criar tarefa' abre o formulário já preso ao lead clicado", async () => {
    const user = userEvent.setup();
    renderPainel();

    await user.click(await screen.findByTestId(`inbox-lead-acoes-${LEAD_GANHO}`));
    await user.click(await screen.findByRole("menuitem", { name: "Criar tarefa" }));

    expect(await screen.findByRole("dialog", { name: "Nova tarefa" })).toBeTruthy();
    expect(screen.getByTestId("tarefa-negocio-fixo").textContent).toBe("CNPJ · Ateliê Marina");
    // O seletor de oportunidade não aparece: o negócio é o do card.
    expect(screen.queryByTestId("tarefa-negocio")).toBeNull();
  });

  it("Cancelar fecha a confirmação sem apagar nada", async () => {
    const user = userEvent.setup();
    renderPainel();

    await user.click(await screen.findByTestId(`inbox-lead-acoes-${LEAD_GANHO}`));
    await user.click(await screen.findByRole("menuitem", { name: "Excluir lead" }));
    await screen.findByTestId("inbox-lead-excluir-confirmacao");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByTestId("inbox-lead-excluir-confirmacao")).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });
});
