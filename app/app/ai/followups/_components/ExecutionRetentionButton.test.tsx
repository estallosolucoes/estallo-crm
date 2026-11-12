import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  org: vi.fn(),
  idioma: "pt-BR" as "pt-BR" | "es",
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: deps.get, patch: deps.patch } }));
vi.mock("@/lib/auth/org-da-aba", () => ({ orgDaAba: deps.org }));
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (text: string) => traduzir(text, deps.idioma) };
});

import { ExecutionRetentionButton } from "./ExecutionRetentionButton";
import { EXECUTION_RETENTION_LIMITS } from "@/lib/followup/execution-retention";

const view = (payload_days = 30, metadata_days = 180, configuration_valid = true) => ({
  data: {
    policy: { payload_days, metadata_days },
    configuration_valid,
    limits: EXECUTION_RETENTION_LIMITS,
  },
});

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  const content = () => (
    <QueryClientProvider client={client}>
      <ExecutionRetentionButton />
    </QueryClientProvider>
  );
  return { ...render(content()), content };
}

async function open() {
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByRole("button", { name: /^Retenção do histórico$/ }));
  await screen.findByLabelText("Dados das etapas (dias)");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.idioma = "pt-BR";
  deps.org.mockReturnValue({ orgId: "org-a" });
  deps.get.mockResolvedValue(view());
  deps.patch.mockImplementation(async (_url, body) => view(body.payload_days, body.metadata_days));
});

describe("configuração da retenção pela interface", () => {
  it("apresenta controles e a política de preservação em espanhol", async () => {
    deps.idioma = "es";
    mount();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: /^Retención del historial$/ }));
    expect(await screen.findByLabelText("Datos de los pasos (días)")).toHaveValue(30);
    expect(screen.getByLabelText("Historial de ejecuciones (días)")).toHaveValue(180);
    expect(screen.getByRole("button", { name: /^Guardar$/ })).toBeVisible();
    expect(
      screen.getByText(
        "Los plazos se aplican a ejecuciones con historial detallado. Los flujos antiguos conservan su historial existente.",
      ),
    ).toBeVisible();
  });
  it("busca só ao abrir, explica os dois prazos e confirma o salvamento", async () => {
    mount();
    expect(deps.get).not.toHaveBeenCalled();
    const user = await open();
    const payload = screen.getByLabelText("Dados das etapas (dias)");
    await user.clear(payload);
    await user.type(payload, "15");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Configuração salva.");
    expect(deps.patch).toHaveBeenCalledWith("/api/v1/ai/followup-flows/retention", {
      payload_days: 15,
      metadata_days: 180,
    });
    expect(
      screen.getByText(
        "Execuções em andamento e dados necessários para continuá-las são preservados.",
      ),
    ).toBeVisible();
  });

  it("recusa prazo de histórico menor e preserva os campos", async () => {
    mount();
    const user = await open();
    const payload = screen.getByLabelText("Dados das etapas (dias)");
    const metadata = screen.getByLabelText("Histórico de execuções (dias)");
    await user.clear(payload);
    await user.type(payload, "60");
    await user.clear(metadata);
    await user.type(metadata, "30");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "O histórico deve ser mantido por pelo menos o prazo dos dados detalhados.",
    );
    expect(deps.patch).not.toHaveBeenCalled();
    expect(payload).toHaveValue(60);
  });

  it("falha ao salvar é visível e não perde a edição", async () => {
    deps.patch.mockRejectedValue(new Error("falha sintética"));
    mount();
    const user = await open();
    const payload = screen.getByLabelText("Dados das etapas (dias)");
    await user.clear(payload);
    await user.type(payload, "15");
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível salvar a retenção do histórico.",
    );
    expect(payload).toHaveValue(15);
  });

  it("configuração inválida informa os padrões que estão em uso", async () => {
    deps.get.mockResolvedValue(view(30, 180, false));
    mount();
    await open();
    expect(screen.getByRole("alert")).toHaveTextContent("A configuração salva é inválida.");
    expect(screen.getByLabelText("Dados das etapas (dias)")).toHaveValue(30);
  });

  it("trocar de empresa fecha o formulário e não reaproveita o rascunho", async () => {
    const mounted = mount();
    const user = await open();
    const payload = screen.getByLabelText("Dados das etapas (dias)");
    await user.clear(payload);
    await user.type(payload, "15");
    deps.org.mockReturnValue({ orgId: "org-b" });
    deps.get.mockResolvedValue(view(90, 365));
    mounted.rerender(mounted.content());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await open();
    await waitFor(() => expect(screen.getByLabelText("Dados das etapas (dias)")).toHaveValue(90));
    expect(deps.patch).not.toHaveBeenCalled();
  });
});
