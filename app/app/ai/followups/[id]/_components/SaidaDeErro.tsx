"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Se a saída "Fallback erro" aparece no construtor. Ela só desvia o fluxo no motor novo de execução
 * (`execution_contract: 1`), que é o de todo fluxo do relógio; o roteiro de atendimento não passa por ele e não a oferece. Mostrá-la ali prometeria um
 * desvio que nunca acontece. Fora de um provider vale `true` (cartões isolados e testes).
 */
const Contexto = createContext(true);

export function SaidaDeErroProvider({ habilitada, children }: { habilitada: boolean; children: ReactNode }) {
  return <Contexto.Provider value={habilitada}>{children}</Contexto.Provider>;
}

export function useSaidaDeErroHabilitada(): boolean {
  return useContext(Contexto);
}
