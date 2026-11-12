import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  fila: vi.fn(),
  dossie: vi.fn(),
  intervir: vi.fn(),
  cancelar: vi.fn(),
  reiniciar: vi.fn(),
  conduzir: vi.fn(),
  aoVivo: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (text: string) => traduzir(text, "pt-BR") };
});
vi.mock("@/hooks/followup/useFollowupQueue", () => ({
  useFollowupQueue: deps.fila,
  useCancelFollowupEnrollment: () => ({ mutate: deps.cancelar }),
  useExecucoesAoVivo: deps.aoVivo,
}));
vi.mock("@/hooks/followup/useFollowupEnrollment", () => ({
  useFollowupEnrollment: deps.dossie,
  useIntervirNoFollowup: () => ({ mutate: deps.intervir, isPending: false }),
  useReiniciarExecucao: () => ({ mutate: deps.reiniciar, isPending: false }),
  useConduzirPassoAPasso: () => ({ mutate: deps.conduzir, isPending: false }),
}));
// O desenho (xyflow) não roda em jsdom: o que importa aqui é o contrato — recebe o grafo pinado e avisa o clique.
vi.mock("next/dynamic", () => ({
  default: () =>
    function CanvasFalso(props: { onSelecionarNo?: (id: string) => void; noSelecionado?: string | null }) {
      return (
        <div data-testid="canvas-falso" data-selecionado={props.noSelecionado ?? ""}>
          <button type="button" onClick={() => props.onSelecionarNo?.("msg")}>
            bloco msg
          </button>
          <button type="button" onClick={() => props.onSelecionarNo?.("fim")}>
            bloco fim
          </button>
        </div>
      );
    },
}));

import { ExecucoesDoFluxo } from "./ExecucoesDoFluxo";

const LINHA = (extra: Record<string, unknown> = {}) => ({
  source: "enrollment",
  id: "e1",
  contact: { id: "c1", name: "Ana" },
  flow_name: "Indicação",
  agent_name: null,
  node_or_reason: "msg",
  next_fire_at: null,
  status: "completed",
  detail: null,
  started_at: "2026-11-05T10:00:00Z",
  completed_at: "2026-11-05T10:12:00Z",
  attempts: 1,
  ...extra,
});

const PASSO = {
  step_id: "s1",
  node_id: "msg",
  rotulo: "Mensagem",
  tipo: "action",
  status: "failed",
  branch_id: null,
  visit: 0,
  entered_at: "2026-11-05T10:00:00Z",
  completed_at: "2026-11-05T10:01:00Z",
  duracao_ms: 60_000,
  tentativas: 1,
  erro: "canal fora",
  entrada: { variavel: "valor-da-entrada" },
  saida: null,
};

const DOSSIE = (extra: Record<string, unknown> = {}) => ({
  id: "e1",
  status: "dead",
  current_node_id: "msg",
  eventos: [],
  origem: null,
  passo_a_passo: false,
  reexecucoes: [],
  started_at: "2026-11-05T10:00:00Z",
  completed_at: "2026-11-05T10:12:00Z",
  attempts: 1,
  max_attempts: 3,
  steps_taken: 2,
  last_error: "O envio deste bloco falhou: canal fora",
  cancel_reason: null,
  contact: { id: "c1", name: "Ana" },
  nos: [
    { id: "msg", tipo: "action", rotulo: "Mensagem", resumo: "Envia o texto" },
    { id: "fim", tipo: "end", rotulo: "Fim", resumo: "" },
  ],
  passos: [PASSO],
  pode_ver_dados: true,
  grafo: { nodes: [], edges: [] },
  ...extra,
});

function montar(props: Partial<React.ComponentProps<typeof ExecucoesDoFluxo>> = {}) {
  const base = {
    flowId: "f1",
    execucaoId: null,
    noId: null,
    onSelecionarExecucao: vi.fn(),
    onSelecionarNo: vi.fn(),
    onVoltarAoEditor: vi.fn(),
    ...props,
  };
  render(<ExecucoesDoFluxo {...base} />);
  return base;
}

beforeEach(() => {
  for (const m of Object.values(deps)) m.mockReset();
  deps.fila.mockReturnValue({
    data: { pages: [{ data: [LINHA(), LINHA({ source: "promise", id: "p1", contact: { id: "c2", name: "Promessa" } })] }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
  deps.dossie.mockReturnValue({ data: undefined, isLoading: false });
  deps.aoVivo.mockReturnValue("connecting");
});

describe("ExecucoesDoFluxo — o histórico dentro do editor", () => {
  it("lista só as execuções DESTE fluxo (consulta travada no fluxo) e ignora promessas", () => {
    montar();
    expect(deps.fila.mock.calls.at(-1)![0]).toMatchObject({ pointer_id: "f1" });
    const itens = screen.getAllByTestId("execucao-do-fluxo");
    expect(itens).toHaveLength(1);
    expect(itens[0]).toHaveTextContent("Ana");
    expect(itens[0]).toHaveTextContent("12 min");
  });

  it("o período vira filtro da consulta (desde/ate), e o filtro de versão só existe quando há versões publicadas", () => {
    montar();
    expect(screen.queryByLabelText("Filtrar por versão")).toBeNull();
    fireEvent.change(screen.getByLabelText("Execuções a partir de"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Execuções até"), { target: { value: "2026-11-07" } });
    expect(deps.fila.mock.calls.at(-1)![0]).toMatchObject({ pointer_id: "f1", desde: "2026-11-01", ate: "2026-11-07" });
  });

  it("com versões publicadas, oferece o filtro por versão e o por modo", () => {
    montar({ versoes: [{ id: "v2", created_at: "2026-11-05T10:00:00Z", numero: 2 }, { id: "v1", created_at: "2026-11-01T10:00:00Z", numero: 1 }] });
    expect(screen.getByLabelText("Filtrar por versão")).toBeInTheDocument();
    expect(screen.getByLabelText("Filtrar por modo")).toBeInTheDocument();
    expect(deps.fila.mock.calls.at(-1)![0]).not.toHaveProperty("versao", "all");
  });

  it("canal ainda não assinado: sem «ao vivo», polling curto de 10 s", () => {
    montar();
    expect(deps.aoVivo).toHaveBeenLastCalledWith("f1", true);
    expect(deps.fila.mock.calls.at(-1)![1]).toEqual({ refetchMs: 10_000 });
    expect(screen.queryByTestId("execucoes-ao-vivo")).toBeNull();
  });

  it("canal assinado mostra «ao vivo» e alonga o polling", () => {
    deps.aoVivo.mockReturnValue("subscribed");
    montar();
    expect(screen.getByTestId("execucoes-ao-vivo")).toBeInTheDocument();
    expect(deps.fila.mock.calls.at(-1)![1]).toEqual({ refetchMs: 60_000 });
  });

  it("clicar numa execução a seleciona (a URL é de quem chama)", async () => {
    const p = montar();
    await userEvent.click(screen.getByTestId("execucao-do-fluxo"));
    expect(p.onSelecionarExecucao).toHaveBeenCalledWith("e1");
  });

  it("sem execução escolhida, orienta; sem execuções no fluxo, diz que não há", () => {
    montar();
    expect(screen.getByText(/Escolha uma execução na lista/)).toBeInTheDocument();
  });

  it("fluxo sem execuções mostra o vazio", () => {
    deps.fila.mockReturnValue({ data: { pages: [{ data: [] }] }, isLoading: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() });
    montar();
    expect(screen.getByTestId("execucoes-vazio")).toBeInTheDocument();
  });

  it("execução aberta: resumo, erro e desenho; clicar num bloco avisa quem chama", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    const p = montar({ execucaoId: "e1" });
    expect(screen.getByTestId("execucao-resumo")).toHaveTextContent("12 min");
    expect(screen.getByTestId("execucao-resumo")).toHaveTextContent("2 passos");
    expect(screen.getByTestId("execucao-erro")).toHaveTextContent("canal fora");
    expect(screen.getByText(/Somente leitura/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("bloco msg"));
    expect(p.onSelecionarNo).toHaveBeenCalledWith("msg");
  });

  it("bloco escolhido mostra o que aconteceu nele, com a entrada já aberta", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    montar({ execucaoId: "e1", noId: "msg" });
    const inspetor = screen.getByTestId("execucao-inspetor");
    expect(within(inspetor).getByText("Envia o texto")).toBeInTheDocument(); // resumo do bloco escolhido
    expect(within(inspetor).getByTestId("caminho-erro")).toHaveTextContent("canal fora");
    expect(within(inspetor).getByText(/valor-da-entrada/)).toBeInTheDocument();
  });

  it("bloco que rodou mais de uma vez mostra uma passagem por vez, a mais recente primeiro", async () => {
    const segunda = { ...PASSO, step_id: "s2", visit: 1, erro: null, status: "completed", entrada: { variavel: "segunda-volta" } };
    deps.dossie.mockReturnValue({ data: DOSSIE({ passos: [PASSO, segunda] }), isLoading: false });
    montar({ execucaoId: "e1", noId: "msg" });
    const abas = screen.getAllByTestId("inspetor-passagem");
    expect(abas).toHaveLength(2);
    expect(abas[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/segunda-volta/)).toBeInTheDocument();
    expect(screen.queryByText(/valor-da-entrada/)).toBeNull();
    await userEvent.click(abas[0]!);
    expect(screen.getByText(/valor-da-entrada/)).toBeInTheDocument();
    expect(screen.queryByText(/segunda-volta/)).toBeNull();
  });

  it("recuperação mostra os passos herdados da original e diz que é recuperação", () => {
    deps.dossie.mockReturnValue({
      data: DOSSIE({
        status: "active",
        origem: { id: "e0", tipo: "retry" },
        passos_herdados: [{ ...PASSO, step_id: "h1", rotulo: "Mapear dados", status: "succeeded", erro: null }],
      }),
      isLoading: false,
    });
    montar({ execucaoId: "e1" });
    expect(screen.getByTestId("passos-herdados")).toHaveTextContent("Mapear dados");
    expect(screen.getByTestId("execucao-origem")).toHaveTextContent("Recuperação");
  });

  it("diário cortado no teto de leitura avisa", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE({ passos_truncados: true }), isLoading: false });
    montar({ execucaoId: "e1" });
    expect(screen.getByTestId("execucao-diario-truncado")).toBeInTheDocument();
  });

  it("bloco com uma passagem só não mostra o seletor", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    montar({ execucaoId: "e1", noId: "msg" });
    expect(screen.queryByTestId("inspetor-passagem")).toBeNull();
  });

  it("bloco que a execução não percorreu diz isso, sem inventar dado", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    montar({ execucaoId: "e1", noId: "fim" });
    expect(screen.getByTestId("inspetor-nao-percorrido")).toBeInTheDocument();
  });

  it("sem permissão para ver dados, a entrada e a saída não aparecem", () => {
    deps.dossie.mockReturnValue({
      data: DOSSIE({ pode_ver_dados: false, passos: [{ ...PASSO, entrada: undefined, saida: undefined }] }),
      isLoading: false,
    });
    montar({ execucaoId: "e1", noId: "msg" });
    expect(screen.queryByText(/valor-da-entrada/)).toBeNull();
    expect(screen.queryByText("Ver entrada e saída")).toBeNull();
  });

  it("morta/concluída não oferece pausar, retomar nem cancelar; o editor volta pelo botão", async () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    const p = montar({ execucaoId: "e1" });
    expect(screen.queryByRole("button", { name: /Pausar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retomar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancelar execução/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Voltar ao editor" }));
    expect(p.onVoltarAoEditor).toHaveBeenCalled();
  });

  it("execução viva pode ser pausada e cancelada (com confirmação); pausada à mão pode ser retomada", async () => {
    deps.dossie.mockReturnValue({ data: DOSSIE({ status: "active", completed_at: null }), isLoading: false });
    montar({ execucaoId: "e1" });
    await userEvent.click(screen.getByRole("button", { name: /Pausar/ }));
    expect(deps.intervir).toHaveBeenCalledWith({ id: "e1", acao: "pause" });
    await userEvent.click(screen.getByRole("button", { name: /Cancelar execução/ }));
    expect(deps.cancelar).not.toHaveBeenCalled(); // só depois de confirmar
    const dialogo = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Cancelar execução" }));
    expect(deps.cancelar).toHaveBeenCalledWith("e1");
  });

  it("pausada à mão oferece retomar", async () => {
    deps.dossie.mockReturnValue({ data: DOSSIE({ status: "paused_manual", completed_at: null }), isLoading: false });
    montar({ execucaoId: "e1" });
    await userEvent.click(screen.getByRole("button", { name: /Retomar/ }));
    expect(deps.intervir).toHaveBeenCalledWith({ id: "e1", acao: "resume" });
  });

  it("execução anterior ao registro passo a passo: avisa, e o bloco não finge que 'não passou'", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE({ passos: [] }), isLoading: false });
    montar({ execucaoId: "e1", noId: "msg" });
    expect(screen.getByTestId("execucao-sem-diario")).toBeInTheDocument();
    expect(screen.getByTestId("inspetor-nao-percorrido")).toHaveTextContent("Não há registro");
  });

  it("execução esperando explica por quê", () => {
    deps.dossie.mockReturnValue({
      data: DOSSIE({
        status: "waiting_reply",
        completed_at: null,
        next_eval_at: "2026-11-06T10:00:00Z",
        no_atual: { id: "msg", rotulo: "Mensagem" },
      }),
      isLoading: false,
    });
    montar({ execucaoId: "e1" });
    expect(screen.getByTestId("execucao-espera")).toHaveTextContent("Esperando a resposta do contato");
  });

  it("execução terminada não mostra a linha de espera", () => {
    deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
    montar({ execucaoId: "e1" });
    expect(screen.queryByTestId("execucao-espera")).toBeNull();
  });

  it("sem diário mas com eventos: reconstrói o caminho, avisa, e o bloco lista os eventos dele", () => {
    deps.dossie.mockReturnValue({
      data: DOSSIE({
        passos: [],
        eventos: [
          { id: "ev1", node_id: "msg", event_type: "node_failed", payload: { error: "canal fora" }, created_at: "2026-11-05T10:05:00Z" },
        ],
      }),
      isLoading: false,
    });
    montar({ execucaoId: "e1", noId: "msg" });
    expect(screen.getByTestId("execucao-reconstruida")).toBeInTheDocument();
    expect(screen.queryByTestId("execucao-sem-diario")).toBeNull();
    expect(screen.getByTestId("canvas-falso")).toBeInTheDocument();
    const eventos = screen.getByTestId("inspetor-eventos");
    expect(eventos).toHaveTextContent("Falhou neste passo");
    expect(eventos).toHaveTextContent("canal fora");
  });

  describe("reexecutar do início", () => {
    it("execução terminada oferece reexecutar; o diálogo avisa do risco e lista os blocos com efeito", async () => {
      deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
      montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("reexecutar-inicio"));
      const dialogo = await screen.findByTestId("dialogo-reiniciar");
      expect(dialogo).toHaveTextContent("a execução original não muda".replace("a", "A"));
      expect(dialogo).toHaveTextContent("inclusive mensagens ao cliente");
      const efeitos = within(dialogo).getByTestId("reiniciar-efeitos");
      expect(efeitos).toHaveTextContent("Mensagem");
      expect(efeitos).toHaveTextContent("já aconteceu na original"); // o passo falhou na original
      expect(deps.reiniciar).not.toHaveBeenCalled(); // só depois de confirmar
    });

    it("confirmar chama com o id e uma chave de idempotência, e abre a execução nova", async () => {
      deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
      const p = montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("reexecutar-inicio"));
      await userEvent.click(await screen.findByTestId("confirmar-reiniciar"));
      expect(deps.reiniciar).toHaveBeenCalledTimes(1);
      const [vars, opcoes] = deps.reiniciar.mock.calls[0]!;
      expect(vars).toMatchObject({ id: "e1" });
      expect(String(vars.chave).length).toBeGreaterThan(8);
      opcoes.onSuccess({ id: "e2" });
      expect(p.onSelecionarExecucao).toHaveBeenCalledWith("e2");
    });

    it("execução viva não oferece reexecutar (primeiro termina ou se cancela)", () => {
      deps.dossie.mockReturnValue({ data: DOSSIE({ status: "waiting_reply", completed_at: null }), isLoading: false });
      montar({ execucaoId: "e1" });
      expect(screen.queryByTestId("reexecutar-inicio")).toBeNull();
    });

    it("com reexecução ainda em andamento, o botão fica desligado", () => {
      deps.dossie.mockReturnValue({
        data: DOSSIE({ reexecucoes: [{ id: "e2", tipo: "restart", status: "active", started_at: "2026-11-05T11:00:00Z" }] }),
        isLoading: false,
      });
      montar({ execucaoId: "e1" });
      expect(screen.getByTestId("reexecutar-inicio")).toBeDisabled();
    });

    it("a reexecução aponta para a original, e a original lista as reexecuções", async () => {
      deps.dossie.mockReturnValue({ data: DOSSIE({ origem: { id: "e0", tipo: "restart" } }), isLoading: false });
      const p = montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("execucao-origem"));
      expect(p.onSelecionarExecucao).toHaveBeenCalledWith("e0");
    });

    it("lista as reexecuções com o estado de cada uma", async () => {
      deps.dossie.mockReturnValue({
        data: DOSSIE({ reexecucoes: [{ id: "e2", tipo: "restart", status: "completed", started_at: "2026-11-05T11:00:00Z" }] }),
        isLoading: false,
      });
      const p = montar({ execucaoId: "e1" });
      const lista = screen.getByTestId("execucao-reexecucoes");
      expect(lista).toHaveTextContent("Concluíd");
      await userEvent.click(within(lista).getByRole("button"));
      expect(p.onSelecionarExecucao).toHaveBeenCalledWith("e2");
    });
  });

  describe("passo a passo", () => {
    const pausada = (extra: Record<string, unknown> = {}) =>
      DOSSIE({
        status: "paused_manual",
        passo_a_passo: true,
        completed_at: null,
        current_node_id: "msg",
        no_atual: { id: "msg", rotulo: "Mensagem" },
        ...extra,
      });

    it("pausada no próximo bloco: mostra qual é e oferece executá-lo; o «Retomar» genérico some", async () => {
      deps.dossie.mockReturnValue({ data: pausada(), isLoading: false });
      montar({ execucaoId: "e1" });
      const faixa = screen.getByTestId("execucao-passo-a-passo");
      expect(faixa).toHaveTextContent("Próximo bloco");
      expect(faixa).toHaveTextContent("Mensagem");
      expect(screen.queryByRole("button", { name: /^Retomar$/ })).toBeNull();
      await userEvent.click(screen.getByTestId("executar-proximo-bloco"));
      expect(deps.conduzir).toHaveBeenCalledWith({ id: "e1", acao: "proximo" });
    });

    it("«Continuar automaticamente» solta a execução", async () => {
      deps.dossie.mockReturnValue({ data: pausada(), isLoading: false });
      montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("continuar-automaticamente"));
      expect(deps.conduzir).toHaveBeenCalledWith({ id: "e1", acao: "continuar" });
    });

    it("rodando o bloco (ativa): sem botões, só o aviso de que a tela atualiza sozinha", () => {
      deps.dossie.mockReturnValue({ data: pausada({ status: "active" }), isLoading: false });
      montar({ execucaoId: "e1" });
      expect(screen.queryByTestId("executar-proximo-bloco")).toBeNull();
      expect(screen.getByTestId("execucao-passo-a-passo")).toHaveTextContent("atualiza sozinha");
    });

    it("execução comum não mostra a faixa de passo a passo e mantém o «Retomar» da pausa por pessoa", () => {
      deps.dossie.mockReturnValue({ data: DOSSIE({ status: "paused_manual", completed_at: null }), isLoading: false });
      montar({ execucaoId: "e1" });
      expect(screen.queryByTestId("execucao-passo-a-passo")).toBeNull();
      expect(screen.getByRole("button", { name: /Retomar/ })).toBeInTheDocument();
    });

    it("reexecutar com a chave «passo a passo» ligada pede a reexecução pausada", async () => {
      deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
      montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("reexecutar-inicio"));
      await userEvent.click(await screen.findByTestId("reiniciar-passo-a-passo"));
      await userEvent.click(screen.getByTestId("confirmar-reiniciar"));
      expect(deps.reiniciar.mock.calls[0]![0]).toMatchObject({ id: "e1", passoAPasso: true });
    });

    it("sem ligar a chave, a reexecução é a automática de sempre", async () => {
      deps.dossie.mockReturnValue({ data: DOSSIE(), isLoading: false });
      montar({ execucaoId: "e1" });
      await userEvent.click(screen.getByTestId("reexecutar-inicio"));
      await userEvent.click(await screen.findByTestId("confirmar-reiniciar"));
      expect(deps.reiniciar.mock.calls[0]![0]).toMatchObject({ id: "e1", passoAPasso: false });
    });
  });
});
