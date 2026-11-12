import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O diálogo grava pelo MESMO caminho do dossiê: POST /leads/:id/produtos com
 * produto, quantidade e desconto (nunca preço) e, se a data mudou, PATCH do lead.
 */

const { get, post, patch } = vi.hoisted(() => ({
  get: vi.fn(async (url: string) =>
    url === "/api/v1/products"
      ? {
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              nome: "Consulta",
              preco_cents: 15000,
              ativo: true,
            },
          ],
        }
      : { data: [] },
  ),
  post: vi.fn(async (..._a: unknown[]) => ({ data: {} })),
  patch: vi.fn(async (..._a: unknown[]) => ({ data: {} })),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get, post, patch } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { AdicionarProdutoDialog } from "./AdicionarProdutoDialog";

const PRODUTO = "11111111-1111-4111-8111-111111111111";

function abrir(aoAdicionar = vi.fn(), aoMudarAbertura = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AdicionarProdutoDialog
        aberto
        aoMudarAbertura={aoMudarAbertura}
        aoAdicionar={aoAdicionar}
        lead={{
          id: "lead-1",
          title: "Pedido da Ana",
          pipeline_id: "p-1",
          currency: "BRL",
          expected_close_date: null,
        }}
      />
    </QueryClientProvider>,
  );
  return { aoAdicionar, aoMudarAbertura };
}

async function escolherProduto() {
  // O Select do Radix não abre no jsdom; o <select> nativo escondido recebe a escolha.
  const nativo = await waitFor(() => {
    const el = document.querySelector("select");
    if (!el || el.options.length < 2) throw new Error("catálogo ainda não chegou");
    return el;
  });
  fireEvent.change(nativo, { target: { value: PRODUTO } });
}

describe("AdicionarProdutoDialog", () => {
  beforeEach(() => {
    post.mockClear();
    patch.mockClear();
  });

  it("mostra o nome do lead e o valor do catálogo vezes a quantidade", async () => {
    abrir();
    expect(screen.getByText("Pedido da Ana")).toBeInTheDocument();
    await escolherProduto();
    fireEvent.change(screen.getByLabelText("Quantidade"), { target: { value: "2" } });
    const valor = (screen.getByTestId("adicionar-produto-valor") as HTMLInputElement).value;
    expect(valor.replace(/\s/g, " ")).toBe("R$ 300,00");
  });

  it("quantidade zero não grava e explica o motivo", async () => {
    abrir();
    await escolherProduto();
    fireEvent.change(screen.getByLabelText("Quantidade"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("adicionar-produto-salvar"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/quantidade/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("grava produto e data pelo caminho do dossiê, fecha e avisa quem abriu", async () => {
    const { aoAdicionar, aoMudarAbertura } = abrir();
    await escolherProduto();
    fireEvent.change(screen.getByLabelText("Quantidade"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Fechamento previsto"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.click(screen.getByTestId("adicionar-produto-salvar"));

    await waitFor(() => expect(aoMudarAbertura).toHaveBeenCalledWith(false));
    expect(post).toHaveBeenCalledWith("/api/v1/leads/lead-1/produtos", {
      product_id: PRODUTO,
      quantidade: 3,
      desconto_cents: 0,
    });
    expect(patch).toHaveBeenCalledWith("/api/v1/leads/lead-1", {
      expected_close_date: "2026-12-01",
    });
    expect(aoAdicionar).toHaveBeenCalled();
  });
});
