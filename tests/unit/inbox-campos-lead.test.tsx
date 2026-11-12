import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

const CONTACT = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const LEAD = {
  id: "l-1",
  title: "Negócio existente",
  status: "open",
  value_cents: 10_000,
  currency: "BRL",
  updated_at: "2026-08-01T00:00:00Z",
  pipeline_id: "p-1",
  description: null,
  tags: [],
  expected_close_date: null,
  custom_fields: { empresa: "ACME" },
  field_defs: [{ key: "empresa", label: "Empresa", type: "text" as const }],
};

const RESPOSTA = {
  leads: [LEAD],
  orders: [],
  activities: [],
  demandas: [],
};

const get = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...args),
  },
}));
/**
 * Com `data: null` o `NewLeadDialog` nunca entra na árvore (o painel só o monta
 * sob `contactId && defaultPipeline.data`), e o caso do rótulo só via a string.
 * Com o funil padrão de verdade o clique abre o diálogo, e o teste passa a
 * guardar a IDENTIDADE do botão — trocar o rótulo com o do editor de tags
 * deixa de ser invisível.
 */
const ETAPA = {
  id: "s-1", organization_id: "org-1", pipeline_id: "p-1", name: "Novo", slug: "novo",
  position: 1000, color: null, is_won: false, is_lost: false, is_archived: false,
  expected_duration_hours: null,
};
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({
    data: {
      pipeline: {
        id: "p-1", organization_id: "org-1", name: "Funil", slug: "funil", description: null,
        is_default: true, is_archived: false, position: 1000, vocabulary: {}, settings: {},
      },
      stages: [ETAPA],
    },
    isError: false,
    isLoading: false,
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// O dossiê real lê o quadro do funil; aqui basta provar QUAL ele abriu.
vi.mock("@/components/kanban/LeadDossierDoFunil", () => ({
  LeadDossierDoFunil: ({ pipelineId, leadId }: { pipelineId: string; leadId: string }) => (
    <div data-testid="dossie-do-funil">{`${pipelineId}:${leadId}`}</div>
  ),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  patch.mockResolvedValue({ data: { ...LEAD } });
});

describe("painel do inbox — campos do lead", () => {
  it("clicar no lead abre o dossiê do funil dele", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();
    await userEvent.click(await screen.findByTestId("inbox-lead-l-1"));
    expect(await screen.findByTestId("dossie-do-funil")).toHaveTextContent("p-1:l-1");
  });

  it("'Ver mais' só aparece quando há mais leads, e pede mais 3", async () => {
    get.mockResolvedValue({ data: { ...RESPOSTA, leads_total: 5 } });
    renderPainel();
    await screen.findByTestId("inbox-lead-l-1");
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining("leads_limit=3"));
    await userEvent.click(screen.getByTestId("inbox-leads-ver-mais"));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(expect.stringContaining("leads_limit=6")),
    );
  });

  it("sem mais leads, não há 'Ver mais'", async () => {
    get.mockResolvedValue({ data: { ...RESPOSTA, leads_total: 1 } });
    renderPainel();
    await screen.findByTestId("inbox-lead-l-1");
    expect(screen.queryByTestId("inbox-leads-ver-mais")).toBeNull();
  });

  it("leitura que FALHA não vira 'Sem leads.'", async () => {
    get.mockRejectedValue(new Error("500"));
    renderPainel();

    const secao = await screen.findByTestId("inbox-campos-lead");
    await waitFor(() => expect(secao.textContent).toMatch(/não consegui ler/i));
    expect(secao.textContent).not.toMatch(/sem leads/i);
  });
});

describe("painel do inbox — o botão diz o que faz (issue #908)", () => {
  // "Lead" era lido como "ver o lead deste contato", mas abre o diálogo que
  // CRIA um novo; o lead existente se edita em "Leads recentes", logo abaixo.
  it("o botão que abre o Novo Lead se chama 'Novo Lead' — e abre o Novo Lead", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    const botao = await screen.findByRole("button", { name: "Novo Lead" });
    expect(screen.queryByRole("button", { name: "Lead" })).toBeNull();

    // O rótulo sozinho não diz de QUEM ele é: sem o clique, trocá-lo com o do
    // editor de tags mantinha o caso verde.
    await userEvent.click(botao);
    expect(await screen.findByRole("dialog", { name: "Novo Lead" })).toBeTruthy();
  });
});

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { support: null } }),
  useActiveOrg: () => ({ currency: "BRL", country: null }),
  useUser: () => ({ id: "0b000000-0000-4000-8000-0000000000aa", full_name: "Quem cria" }),
}));
