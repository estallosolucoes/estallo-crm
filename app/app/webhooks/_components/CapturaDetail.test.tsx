/**
 * O painel da captação: o campo que o formulário mandou ganha rótulo quando já
 * está cadastrado no funil, e pode ser cadastrado ali mesmo quando não está.
 *
 * O que estes casos trancam:
 *  1. O rótulo cadastrado substitui a chave crua — e só onde há definição.
 *  2. O cadastro acrescenta ao que JÁ existe (nunca regrava só o campo novo) e parte
 *     da leitura FRESCA do funil: outro admin pode ter cadastrado um campo há um
 *     minuto, e `updatePipelineConfig` regrava `fields` inteiro.
 *  3. Sem funil legível (quem não é manager, fonte apagada) ou com nome que a API
 *     recusaria, não se oferece um botão que sempre falharia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { LeadCaptureRow } from "@/hooks/webhooks/useLeadCaptures";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
// O campo nasce no cadastro central (POST /api/v1/custom-fields), visível só neste funil — o fork trocou a
// regravação de `settings.fields` do funil (updatePipelineConfig) por esta rota (b32b7ab08).
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(async () => ({})) },
}));

const FONTE = "00000000-0000-4000-8000-0000000000f1";
const FUNIL = "00000000-0000-4000-8000-0000000000aa";

const estado = vi.hoisted(() => ({
  fontes: [] as Array<{ id: string; default_pipeline_id: string }>,
  funis: [] as Array<{ id: string; settings: Record<string, unknown> }>,
  /** O que a leitura FRESCA devolve — pode diferir do que a tela tinha em cache. */
  funisFrescos: null as null | Array<{ id: string; settings: Record<string, unknown> }>,
}));

vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: estado.fontes } }),
  usePipelines: () => ({
    data: { data: estado.funis },
    refetch: async () => ({ data: { data: estado.funisFrescos ?? estado.funis } }),
  }),
}));

// O Radix (Sheet e Select) exige estes recursos do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { apiClient } from "@/lib/api/client";
import { CapturaDetail } from "./CapturaDetail";

function captura(fields: Record<string, unknown>): LeadCaptureRow {
  return {
    id: "c1",
    received_at: "2026-09-30T20:00:00Z",
    source_name: "Site",
    webhook_source_id: FONTE,
    lead_id: null,
    contact_id: null,
    outcome: "criado",
    reject_reason: null,
    captured_name: "Maria Teste",
    captured_phone: "+5511988887777",
    captured_email: "maria.teste@example.com",
    fields,
    utm: {},
    remote_ip: null,
    user_agent: null,
    origin: null,
  };
}

function abrir(c: LeadCaptureRow) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <CapturaDetail captura={c} onOpenChange={() => {}} />
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.post).mockClear();
  estado.fontes = [{ id: FONTE, default_pipeline_id: FUNIL }];
  estado.funis = [
    {
      id: FUNIL,
      settings: { fields: [{ key: "servico", label: "Serviço que precisa", type: "select" }] },
    },
  ];
  estado.funisFrescos = null;
});

describe("campo já cadastrado", () => {
  it("aparece pelo rótulo do funil, sem botão de cadastrar", () => {
    abrir(captura({ servico: "projeto_customizado" }));
    expect(screen.getByText("Serviço que precisa")).toBeTruthy();
    expect(screen.queryByText("servico")).toBeNull();
    expect(screen.queryByText("Cadastrar como campo do lead")).toBeNull();
  });
});

describe("campo novo", () => {
  it("oferece cadastrar, com rótulo e tipo sugeridos pelo que chegou", () => {
    abrir(captura({ contato_email: "maria@example.com" }));
    fireEvent.click(screen.getByText("Cadastrar como campo do lead"));
    expect((screen.getByLabelText("Rótulo") as HTMLInputElement).value).toBe("Contato email");
  });

  it("cadastra só o campo novo no cadastro central, visível neste funil", async () => {
    abrir(captura({ cidade: "Goiânia" }));
    fireEvent.click(screen.getByText("Cadastrar como campo do lead"));
    fireEvent.change(screen.getByLabelText("Rótulo"), { target: { value: "Cidade" } });
    fireEvent.click(screen.getByText("Salvar"));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/custom-fields", {
      entity: "lead",
      key: "cidade",
      label: "Cidade",
      type: "text",
      visivel_global: false,
      funis_visiveis: [FUNIL],
    });
  });

  it("parte da leitura FRESCA: o campo que outro admin acabou de cadastrar não é cadastrado de novo", async () => {
    estado.funisFrescos = [
      {
        id: FUNIL,
        settings: {
          fields: [
            { key: "servico", label: "Serviço que precisa", type: "select" },
            { key: "cidade", label: "Cidade", type: "text" },
          ],
        },
      },
    ];
    abrir(captura({ cidade: "Goiânia" }));
    fireEvent.click(screen.getByText("Cadastrar como campo do lead"));
    fireEvent.click(screen.getByText("Salvar"));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("rótulo vazio não grava nada", async () => {
    abrir(captura({ cidade: "Goiânia" }));
    fireEvent.click(screen.getByText("Cadastrar como campo do lead"));
    fireEvent.change(screen.getByLabelText("Rótulo"), { target: { value: "   " } });
    fireEvent.click(screen.getByText("Salvar"));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe("quando NÃO se oferece o botão", () => {
  it("nome de campo que a API recusaria (hífen, colchete…)", () => {
    abrir(captura({ "e-mail-2": "x", "fields[x][value]": "y" }));
    expect(screen.queryByText("Cadastrar como campo do lead")).toBeNull();
  });

  it("funil ilegível para quem abre (sem papel de manager)", () => {
    estado.funis = [];
    abrir(captura({ cidade: "Goiânia" }));
    expect(screen.queryByText("Cadastrar como campo do lead")).toBeNull();
  });

  it("fonte que não existe mais", () => {
    estado.fontes = [];
    abrir(captura({ cidade: "Goiânia" }));
    expect(screen.queryByText("Cadastrar como campo do lead")).toBeNull();
  });
});
