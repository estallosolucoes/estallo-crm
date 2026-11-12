import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";

const get = vi.hoisted(() =>
  vi.fn(async () => ({ data: [{ id: "l-9", title: "Ernanda coelho" }] })),
);
vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-1" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isSuccess: true }),
}));

function renderForm(aoSalvar = vi.fn(async () => undefined), leadId?: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FormularioDeTarefa aberto aoMudarAbertura={vi.fn()} aoSalvar={aoSalvar} leadId={leadId} />
    </QueryClientProvider>,
  );
  return aoSalvar;
}

describe("Tarefa vinculada a uma oportunidade", () => {
  it("escolhe o negócio pela busca e envia o lead_id", async () => {
    const aoSalvar = renderForm();
    await userEvent.type(screen.getByLabelText("O que precisa ser feito"), "Confirmar pagamento");
    await userEvent.click(screen.getByTestId("tarefa-escolher-negocio"));
    await userEvent.click(await screen.findByRole("button", { name: "Ernanda coelho" }));
    expect(screen.getByTestId("tarefa-negocio")).toHaveTextContent("Ernanda coelho");

    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(aoSalvar).toHaveBeenCalledWith(expect.objectContaining({ lead_id: "l-9" })),
    );
    expect(get).toHaveBeenCalledWith(expect.stringContaining("/api/v1/leads?"));
  });

  it("aberto pelo dossiê (lead fixo), não oferece o seletor", () => {
    renderForm(vi.fn(), "l-1");
    expect(screen.queryByTestId("tarefa-escolher-negocio")).toBeNull();
  });
});
