import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcoesDaConversa } from "@/components/inbox/AcoesDaConversa";

/**
 * A setinha de cada conversa no Inbox (16/10/2026): Fixar/Desafixar, Marcar
 * como não lida, Limpar e Apagar. Limpar e Apagar são de gestor+ e só agem
 * depois da confirmação.
 */

const api = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
const papel = vi.hoisted(() => ({ atual: "manager" as "agent" | "manager" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: papel.atual },
  }),
}));

const ID = "c0000000-0000-4000-8000-000000000001";

function montar(props: Partial<React.ComponentProps<typeof AcoesDaConversa>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AcoesDaConversa conversationId={ID} nome="Marina" fixada={false} aberta={false} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  papel.atual = "manager";
  api.post.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue({ data: {} });
});

describe("menu da conversa", () => {
  it("gestor vê as quatro ações; fixar chama a rota de pin", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    for (const item of ["Fixar conversa", "Marcar como não lida", "Limpar conversa", "Apagar conversa"]) {
      expect(screen.getByRole("menuitem", { name: item })).toBeTruthy();
    }
    await user.click(screen.getByRole("menuitem", { name: "Fixar conversa" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/v1/conversations/${ID}/pin`, {}));
  });

  it("fixada, a opção vira Desafixar (DELETE do pin)", async () => {
    const user = userEvent.setup();
    montar({ fixada: true });
    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    await user.click(screen.getByRole("menuitem", { name: "Desafixar conversa" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/v1/conversations/${ID}/pin`));
  });

  it("atendente não vê Limpar nem Apagar", async () => {
    papel.atual = "agent";
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    expect(screen.queryByRole("menuitem", { name: "Limpar conversa" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Apagar conversa" })).toBeNull();
  });

  it("marcar como não lida com a conversa aberta fecha a conversa", async () => {
    const user = userEvent.setup();
    const fechar = vi.fn();
    montar({ aberta: true, onFecharConversa: fechar });
    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    await user.click(screen.getByRole("menuitem", { name: "Marcar como não lida" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/api/v1/conversations/${ID}/mark-unread`, {}),
    );
    expect(fechar).toHaveBeenCalled();
  });

  it("apagar só acontece depois de confirmar — e Cancelar não apaga", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    await user.click(screen.getByRole("menuitem", { name: "Apagar conversa" }));
    expect(await screen.findByTestId("confirmar-acao-da-conversa")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Ações da conversa: Marina" }));
    await user.click(screen.getByRole("menuitem", { name: "Apagar conversa" }));
    await user.click(await screen.findByRole("button", { name: "Apagar conversa" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/v1/conversations/${ID}`));
  });
});
