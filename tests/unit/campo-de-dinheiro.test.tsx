import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { CampoDeDinheiro } from "@/components/ui/campo-de-dinheiro";
import {
  centavosParaCampo,
  mascararDinheiro,
  normalizarParaCampo,
  parseReaisToCents,
} from "@/lib/money";

/**
 * A máscara única dos campos de dinheiro: dígitos entram da direita para a
 * esquerda, sempre com duas casas, ponto no milhar e vírgula no decimal — e o
 * texto mascarado é o mesmo que `parseReaisToCents` grava em centavos.
 */

describe("mascararDinheiro — a tabela do pedido", () => {
  it.each([
    ["1", "0,01"],
    ["12", "0,12"],
    ["123", "1,23"],
    ["1234", "12,34"],
    ["12345", "123,45"],
    ["1234567", "12.345,67"],
  ])("%s → %s", (teclas, esperado) => {
    expect(mascararDinheiro(teclas)).toBe(esperado);
  });

  it("letra e símbolo não entram; sem dígito o campo fica vazio", () => {
    expect(mascararDinheiro("12a3")).toBe("1,23");
    expect(mascararDinheiro("abc")).toBe("");
    expect(mascararDinheiro("")).toBe("");
  });

  it("o mascarado volta a ser o MESMO número de centavos ao gravar", () => {
    for (const cents of [0, 1, 99, 100, 24990, 123456, 1234567, 99999999999]) {
      expect(parseReaisToCents(centavosParaCampo(cents))).toBe(cents);
    }
  });

  it("valor vindo de fora é lido como valor, não como teclas", () => {
    expect(normalizarParaCampo("249.9")).toBe("249,90");
    expect(normalizarParaCampo("1234,5")).toBe("1.234,50");
    expect(normalizarParaCampo("1.234,56")).toBe("1.234,56");
    expect(normalizarParaCampo("R$ 10")).toBe("10,00");
    expect(normalizarParaCampo("")).toBe("");
    expect(centavosParaCampo(null)).toBe("");
  });
});

function ComFormulario({ aoSalvar }: { aoSalvar: (cents: number | null) => void }) {
  const form = useForm<{ valor: string }>({ defaultValues: { valor: centavosParaCampo(123456) } });
  return (
    <form onSubmit={form.handleSubmit((v) => aoSalvar(parseReaisToCents(v.valor)))}>
      <label htmlFor="v">Valor</label>
      <CampoDeDinheiro id="v" {...form.register("valor")} />
      <button type="submit">Salvar</button>
    </form>
  );
}

function Controlado() {
  const [valor, setValor] = useState("");
  return (
    <>
      <label htmlFor="c">Preço</label>
      <CampoDeDinheiro id="c" value={valor} onChange={(e) => setValor(e.target.value)} />
      <output>{parseReaisToCents(valor) ?? "vazio"}</output>
    </>
  );
}

describe("CampoDeDinheiro", () => {
  it("mostra o símbolo da moeda antes do valor", () => {
    render(<Controlado />);
    expect(screen.getByLabelText("Preço").parentElement?.textContent).toContain("R$");
  });

  it("digitação progressiva, apagar e letras (controlado)", async () => {
    const user = userEvent.setup();
    render(<Controlado />);
    const campo = screen.getByLabelText("Preço") as HTMLInputElement;

    await user.type(campo, "1234567");
    expect(campo.value).toBe("12.345,67");
    expect(screen.getByRole("status").textContent).toBe("1234567");

    await user.type(campo, "{Backspace}");
    expect(campo.value).toBe("1.234,56");

    await user.type(campo, "x");
    expect(campo.value).toBe("1.234,56");

    await user.clear(campo);
    expect(campo.value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("vazio");
  });

  it("colar lê o texto como valor", () => {
    render(<Controlado />);
    const campo = screen.getByLabelText("Preço") as HTMLInputElement;
    fireEvent.paste(campo, { clipboardData: { getData: () => "R$ 1.234,56" } });
    expect(campo.value).toBe("1.234,56");
    fireEvent.paste(campo, { clipboardData: { getData: () => "249.90" } });
    expect(campo.value).toBe("249,90");
    // Colar texto sem número não estraga o que já estava.
    fireEvent.paste(campo, { clipboardData: { getData: () => "abc" } });
    expect(campo.value).toBe("249,90");
  });

  it("com react-hook-form: carrega o salvo mascarado e grava centavos", async () => {
    const user = userEvent.setup();
    let salvo: number | null = -1;
    render(<ComFormulario aoSalvar={(c) => (salvo = c)} />);
    const campo = screen.getByLabelText("Valor") as HTMLInputElement;
    expect(campo.value).toBe("1.234,56");

    await user.type(campo, "7");
    expect(campo.value).toBe("12.345,67");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(salvo).toBe(1234567);
  });
});
