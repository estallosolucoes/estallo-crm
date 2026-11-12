/**
 * O editor de CAMPOS do funil — o que ele oferece e o que ele deixa editar.
 *
 * O defeito que estes testes trancam: a lista de tipos desta tela era digitada
 * à mão e ficou menor que a de `customFieldSchema`. `multiselect` era aceito
 * pelo schema, gravado pela API e desenhado no dossiê do contato, mas não
 * existia aqui — então um campo desse tipo abria com o seletor EM BRANCO (nenhum
 * `SelectItem` casava com o `value`) e sem a linha de opções, que só aparecia
 * para `select`. Quem administrava via um campo aparentemente corrompido, sem
 * como editar, e o conserto intuitivo (escolher um tipo qualquer para tirar o
 * branco) rebaixava a escolha múltipla para escolha única.
 *
 * Por isso os testes medem o par: a tela OFERECE todo tipo que o schema aceita,
 * e mostra as opções para TODO tipo de lista fechada — não só para `select`.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { customFieldSchema } from "@/lib/schemas/settings";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções irmãs falam com a API; este arquivo é sobre os CAMPOS.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import {
  PipelinesClient,
  TIPOS_DE_CAMPO,
  tipoTemOpcoes,
  type EtapaDoFunil,
  type PipelineRow,
} from "./_client";

/** Um funil de clínica: o campo que importa é a lista de procedimentos, e ela é múltipla. */
const FUNIL: PipelineRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tratamentos",
  slug: "tratamentos",
  vocabulary: { lead: "Paciente", deal: "Tratamento", won: "Fechado", lost: "Perdido" },
  settings: {
    fields: [
      {
        key: "procedimentos_de_interesse",
        label: "Procedimentos de interesse",
        type: "multiselect",
        options: [
          { value: "clareamento", label: "Clareamento Dental" },
          { value: "implantes", label: "Implantes" },
        ],
      },
    ],
  },
};

describe("tipos de campo que a tela do funil oferece", () => {
  it("oferece TODO tipo que o schema aceita — lista menor deixa campo salvo sem seletor", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    const daTela = [...TIPOS_DE_CAMPO].sort();
    expect(daTela).toEqual(doSchema);
  });

  it("mostra as opções para toda lista fechada, não só para `select`", () => {
    expect(tipoTemOpcoes("select")).toBe(true);
    expect(tipoTemOpcoes("multiselect")).toBe(true);
    // Um tipo de texto livre não tem lista para editar.
    expect(tipoTemOpcoes("text")).toBe(false);
    expect(tipoTemOpcoes("date")).toBe(false);
  });
});

// Estallo: o editor de campos por funil saiu desta tela e virou o cadastro
// central (/app/crm/campos); os casos dele moram em app/app/crm/campos.

describe("retomada de negócio encerrado (#1538)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

  // 30/10/2026: a escolha saiu do funil — quem move um encerrado escolhe no
  // diálogo "Criar novo negócio × Mover este". A opção some da tela e salvar não
  // a grava mais (um valor antigo fica inerte: `modoDeReabertura`).
  it("a opção de reabertura não existe mais no funil e salvar não a grava", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, reabertura: "novo_negocio" } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    expect(screen.queryByLabelText("Negócio encerrado que volta abre um negócio novo")).toBeNull();

    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1]).not.toHaveProperty("reabertura");
  });
});

describe("comanda do ganho (#1477)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
  const ROTULO = "Abrir comanda ao ganhar um negócio neste funil";

  it("nasce desligada e ligar grava `comanda_no_ganho: true` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig comandaDisponivel />);
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });

  it("funil já ligado abre marcado, e desligar grava `false`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig comandaDisponivel />);
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(false);
  });

  it("sem o módulo financeiro (#1907) o interruptor some, e salvar não mexe no valor gravado", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    expect(screen.queryByLabelText(ROTULO)).toBeNull();

    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });
});
