"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import {
  MOEDA_PADRAO,
  centavosParaCampo,
  mascararDinheiro,
  normalizarParaCampo,
  parseReaisToCents,
  simboloDaMoeda,
} from "@/lib/money";
import { cn } from "@/lib/utils";

type Props = Omit<React.ComponentProps<"input">, "type" | "inputMode"> & {
  /** A moeda do valor — só muda o símbolo desenhado à esquerda ("R$", "US$", "€"). */
  moeda?: string;
  /** Classe do contorno (largura do campo em telas de campo estreito). Padrão: `w-full`. */
  containerClassName?: string;
};

/** O `value` do DOM, escrito de um jeito que o React (e o react-hook-form) enxergam. */
function escreverComoDigitado(el: HTMLInputElement, texto: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, texto);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * O campo de DINHEIRO do produto — um só, para toda tela.
 *
 * Digita da direita para a esquerda com duas casas ("1" → 0,01; "1234567" →
 * 12.345,67), só aceita dígito, e mostra o símbolo da moeda antes do valor. O
 * texto entregue ao formulário é o mascarado ("12.345,67", sem símbolo), que
 * `parseReaisToCents` lê — quem grava não muda.
 *
 * Funciona nos dois jeitos que o produto usa campo: `register()` do
 * react-hook-form (não controlado) e `value`/`onChange` (controlado). A
 * máscara é aplicada no próprio evento antes de chegar a quem chamou.
 *
 * Colar lê o texto como VALOR ("R$ 1.234,56", "249.90"), não como teclas.
 */
export const CampoDeDinheiro = React.forwardRef<HTMLInputElement, Props>(
  (
    {
      moeda = MOEDA_PADRAO,
      containerClassName,
      className,
      style,
      value,
      defaultValue,
      onChange,
      onPaste,
      placeholder,
      ...props
    },
    ref,
  ) => {
    const simbolo = simboloDaMoeda(moeda);
    return (
      <div className={cn("relative", containerClassName ?? "w-full")}>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-text-muted md:text-sm"
        >
          {simbolo}
        </span>
        <Input
          ref={ref}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder ?? "0,00"}
          className={cn("tabular-nums", className)}
          style={{ paddingLeft: `calc(0.75rem + ${simbolo.length + 1}ch)`, ...style }}
          {...(value !== undefined ? { value: normalizarParaCampo(value as string | number) } : {})}
          {...(defaultValue !== undefined
            ? { defaultValue: normalizarParaCampo(defaultValue as string | number) }
            : {})}
          onChange={(e) => {
            const mascarado = mascararDinheiro(e.target.value);
            e.target.value = mascarado;
            // Digita da direita para a esquerda: o cursor mora no fim.
            e.target.setSelectionRange?.(mascarado.length, mascarado.length);
            onChange?.(e);
          }}
          onPaste={(e) => {
            onPaste?.(e);
            if (e.defaultPrevented) return;
            e.preventDefault();
            const colado = e.clipboardData.getData("text").replace(/[^\d.,]/g, "");
            const cents = parseReaisToCents(colado);
            if (cents !== null) escreverComoDigitado(e.currentTarget, centavosParaCampo(cents));
          }}
          {...props}
        />
      </div>
    );
  },
);
CampoDeDinheiro.displayName = "CampoDeDinheiro";
