import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { useTagsDoContato } from "@/hooks/contacts/useTagsDoContato";

/**
 * Estallo (0659): atribuir etiqueta oferece as CADASTRADAS daquela entidade
 * (tela Tags) e permite criar na hora. O cadastro vem de `/api/v1/tags/cores`,
 * com a entidade de cada etiqueta.
 */

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1" } }),
}));
const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
const mutate = vi.fn();
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate, isPending: false }),
}));

const CADASTRO = [
  { tag: "VIP", cor: "#1099d3", entidade: "contact" },
  { tag: "Retorno", cor: null, entidade: "contact" },
  { tag: "Proposta enviada", cor: "#10ba84", entidade: "lead" },
];

/** Como o `CRMSidePanel` monta: o editor lê e grava pela lista otimista. */
function Editor({ tags }: { tags: string[] }) {
  const { tags: visiveis, aplicar } = useTagsDoContato("c-1", tags);
  return <ContactTagsEditor tags={visiveis} onChange={aplicar} />;
}

function montar(tags: string[]) {
  get.mockResolvedValue({ data: CADASTRO });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Editor tags={tags} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  mutate.mockReset();
});

describe("seletor de tags do contato", () => {
  it("oferece só as cadastradas de CONTATO que o contato ainda não tem, e clicar grava", async () => {
    montar(["vip"]);
    await userEvent.click(screen.getByLabelText("Adicionar tag ao contato"));
    const retorno = await screen.findByRole("option", { name: /Retorno/ }, { timeout: 5000 });
    expect(get).toHaveBeenCalledWith("/api/v1/tags/cores");
    // "VIP" já está (caixa diferente) e "Proposta enviada" é de oportunidade.
    expect(screen.queryByRole("option", { name: /VIP/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Proposta enviada/ })).toBeNull();

    await userEvent.click(retorno);
    // O contato grava a forma normalizada, como o servidor.
    expect(mutate).toHaveBeenCalledWith({ tags: ["vip", "retorno"] }, expect.anything());
  });

  it("cria na hora uma tag que não está no cadastro", async () => {
    montar([]);
    const campo = screen.getByLabelText("Adicionar tag ao contato");
    await userEvent.type(campo, "Indicação");
    await userEvent.click(await screen.findByRole("option", { name: /Criar «Indicação»/ }));
    expect(mutate).toHaveBeenCalledWith({ tags: ["indicação"] }, expect.anything());
  });

  it("a tag aparece NO CLIQUE, sem esperar o servidor, e o campo não trava", async () => {
    montar([]);
    const campo = screen.getByLabelText("Adicionar tag ao contato");
    await userEvent.type(campo, "Quente");
    await userEvent.click(await screen.findByRole("option", { name: /Criar «Quente»/ }));
    // `mutate` não resolveu (é um mock): o chip já está na tela e o campo segue livre.
    expect(screen.getByRole("button", { name: /Remover tag quente/ })).toBeInTheDocument();
    expect(campo).not.toBeDisabled();
  });

  it("erro na gravação desfaz a tag na tela", async () => {
    montar([]);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "Quente");
    await userEvent.click(await screen.findByRole("option", { name: /Criar «Quente»/ }));
    const callbacks = mutate.mock.calls[0]![1] as { onError: () => void };
    act(() => callbacks.onError());
    expect(screen.queryByRole("button", { name: /Remover tag quente/ })).toBeNull();
  });

  it("digitar o nome de uma cadastrada não oferece 'Criar' — usa a do cadastro", async () => {
    montar([]);
    await userEvent.type(screen.getByLabelText("Adicionar tag ao contato"), "retorno");
    await screen.findByRole("option", { name: /Retorno/ }, { timeout: 5000 });
    expect(screen.queryByRole("option", { name: /Criar/ })).toBeNull();
  });

  it("a lista abre POR CIMA da tela, fora do card que corta o que transborda", async () => {
    // O card recolhível do Inbox tem `overflow-hidden`: dentro dele, a lista
    // ficava escondida abaixo da borda (print do usuário, 15/10/2026).
    get.mockResolvedValue({ data: CADASTRO });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <section data-testid="card" className="overflow-hidden">
          <Editor tags={[]} />
        </section>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByLabelText("Adicionar tag ao contato"));
    const lista = await screen.findByRole("listbox", {}, { timeout: 5000 });
    expect(screen.getByTestId("card").contains(lista)).toBe(false);
    // E o foco fica no campo: quem abriu a lista continua digitando.
    expect(document.activeElement).toBe(screen.getByLabelText("Adicionar tag ao contato"));
  });
});
