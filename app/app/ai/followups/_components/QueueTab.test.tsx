import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ fila: vi.fn() }));

vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (text: string) => traduzir(text, "pt-BR") };
});
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: { modulos_ligados: [] } }) }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({ useFollowupFlows: () => ({ data: [] }) }));
vi.mock("@/hooks/followup/useFollowupQueue", () => ({
  useFollowupQueue: deps.fila,
  useCancelFollowupEnrollment: () => ({ mutate: vi.fn() }),
  useCancelFollowupPromise: () => ({ mutate: vi.fn() }),
}));

import { QueueTab } from "./QueueTab";

const LINHA = {
  source: "enrollment" as const,
  id: "e1",
  contact: { id: "c1", name: "Ana" },
  flow_name: "Indicação",
  agent_name: null,
  node_or_reason: "n1",
  next_fire_at: null,
  status: "completed",
  detail: null,
  started_at: "2026-11-05T10:00:00Z",
  completed_at: "2026-11-05T10:12:00Z",
  attempts: 3,
  steps_taken: 4,
  version_id: "v1",
  mode: "production",
};

beforeEach(() => {
  deps.fila.mockReset();
  deps.fila.mockReturnValue({
    data: { pages: [{ data: [LINHA] }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
});

const ultimaChamada = () => deps.fila.mock.calls.at(-1)! as [Record<string, unknown>, { refetchMs: number | false }];

describe("QueueTab — filtros do histórico", () => {
  it("o período vira os filtros desde/ate da consulta", () => {
    render(<QueueTab canWrite={false} />);
    fireEvent.change(screen.getByLabelText("Execuções iniciadas a partir de"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Execuções iniciadas até"), { target: { value: "2026-11-05" } });
    expect(ultimaChamada()[0]).toMatchObject({ desde: "2026-11-01", ate: "2026-11-05" });
  });

  it("sem tocar nos filtros novos, a consulta não leva período nem modo", () => {
    render(<QueueTab canWrite={false} />);
    const f = ultimaChamada()[0];
    expect(f.desde).toBeUndefined();
    expect(f.ate).toBeUndefined();
    expect(f.modo).toBeUndefined();
  });

  it("a atualização automática começa desligada e liga o polling quando marcada", () => {
    render(<QueueTab canWrite={false} />);
    expect(ultimaChamada()[1].refetchMs).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Atualizar automaticamente" }));
    expect(ultimaChamada()[1].refetchMs).toBe(10_000);
  });

  it("mostra início, duração e tentativas da execução; promessa (sem início) mostra traço", () => {
    deps.fila.mockReturnValue({
      data: {
        pages: [
          {
            data: [
              LINHA,
              { ...LINHA, source: "promise", id: "p1", started_at: undefined, completed_at: undefined, attempts: undefined },
            ],
          },
        ],
      },
      isLoading: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    render(<QueueTab canWrite={false} />);
    const celulas = screen.getAllByTestId("queue-inicio-duracao");
    expect(celulas).toHaveLength(1);
    expect(celulas[0]!.textContent).toContain("12 min");
    expect(celulas[0]!.textContent).toContain("3 tentativas");
  });
});
