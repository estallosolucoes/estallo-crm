import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MENU "/" PELO TECLADO.
 *
 * ↑/↓ andam pela lista sem tirar o foco do campo; Enter APLICA a resposta
 * (insere o texto, não envia); Esc fecha sem escolher. O Enter de envio só vale
 * com o menu fechado — o caso que mais custa é o Enter de seleção virar envio.
 */

const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: sendMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({
    data: [
      { id: "1", title: "Boas vindas", body: "Olá, seja bem-vindo!", shortcut: null, owner_user_id: null },
      { id: "2", title: "Boas festas", body: "Feliz natal!", shortcut: null, owner_user_id: null },
      { id: "3", title: "Promoção", body: "Desconto hoje", shortcut: "promo", owner_user_id: null },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [], isLoading: false }) }));

import { Composer } from "@/components/inbox/Composer";

function campo() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
  return screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
}

const selecionada = () => screen.getByRole("option", { selected: true });

describe("Composer — menu / pelo teclado", () => {
  beforeEach(() => sendMock.mockClear());

  it("abre com a primeira opção marcada e ↓ ↓ Enter aplica a terceira sem enviar", () => {
    const ta = campo();
    fireEvent.change(ta, { target: { value: "/" } });
    expect(selecionada()).toHaveTextContent("Boas vindas");

    fireEvent.keyDown(ta, { key: "ArrowDown" });
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(selecionada()).toHaveTextContent("Promoção");
    expect(ta).toHaveAttribute("aria-activedescendant", "slash-opcao-3");

    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("Desconto hoje");
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("↑ na primeira volta para a última, e o filtro com espaço reinicia o destaque", () => {
    const ta = campo();
    fireEvent.change(ta, { target: { value: "/" } });
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(selecionada()).toHaveTextContent("Promoção");

    fireEvent.change(ta, { target: { value: "/boas f" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(selecionada()).toHaveTextContent("Boas festas");
  });

  it("Esc fecha sem escolher, e o Enter seguinte envia normalmente", () => {
    const ta = campo();
    fireEvent.change(ta, { target: { value: "/boas" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(ta.value).toBe("/boas");

    fireEvent.keyDown(ta, { key: "Enter" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
