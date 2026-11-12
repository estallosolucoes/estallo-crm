"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/auth/AuthProvider";

/**
 * Funis fixados no menu lateral (Estallo): até 3, na ordem em que foram fixados.
 *
 * Preferência POR NAVEGADOR E POR ORGANIZAÇÃO — sem tabela nem rota. A chave
 * leva o id da organização ativa: um funil é de uma organização só, e a chave
 * única de antes mostrava o funil fixado na Estallo também na Prática (o link
 * levava a um funil que a outra organização não enxerga). O nome viaja junto do id para o menu não precisar buscar os funis em
 * toda tela; quem abre o quadro de um funil fixado atualiza o nome (`renomear`).
 * ponytail: localStorage; vira coluna de preferência do usuário se precisar
 * acompanhar a pessoa entre computadores.
 */
export interface FunilFixado {
  id: string;
  nome: string;
}

export const MAXIMO_DE_FUNIS_FIXADOS = 3;
const EVENTO = "funis-fixados-mudou";
const VAZIO: FunilFixado[] = [];

/** A chave da organização. Sem organização ativa não há o que fixar. */
export function chaveDosFunisFixados(orgId: string): string {
  return `sidebar-funis-fixados:${orgId}`;
}

/** Último valor lido por chave — `useSyncExternalStore` exige a mesma referência. */
const cache = new Map<string, { bruto: string | null; lista: FunilFixado[] }>();

function ler(chave: string | null): FunilFixado[] {
  if (!chave) return VAZIO;
  let bruto: string | null = null;
  try {
    bruto = window.localStorage.getItem(chave);
  } catch {
    return VAZIO; // storage bloqueado (aba privada): nada fixado.
  }
  const anterior = cache.get(chave);
  if (anterior && anterior.bruto === bruto) return anterior.lista;
  let lista: FunilFixado[] = VAZIO;
  try {
    const dado = bruto ? (JSON.parse(bruto) as unknown) : [];
    lista = Array.isArray(dado)
      ? dado
          .filter((f): f is FunilFixado => typeof f?.id === "string" && typeof f?.nome === "string")
          .slice(0, MAXIMO_DE_FUNIS_FIXADOS)
      : VAZIO;
  } catch {
    lista = VAZIO;
  }
  cache.set(chave, { bruto, lista });
  return lista;
}

function gravar(chave: string | null, lista: FunilFixado[]) {
  if (!chave) return;
  try {
    window.localStorage.setItem(chave, JSON.stringify(lista));
  } catch {
    // Sem storage o clique não persiste; a tela segue funcionando.
  }
  window.dispatchEvent(new Event(EVENTO));
}

function assinar(aviso: () => void) {
  window.addEventListener(EVENTO, aviso);
  window.addEventListener("storage", aviso); // outra aba
  return () => {
    window.removeEventListener(EVENTO, aviso);
    window.removeEventListener("storage", aviso);
  };
}

export function useFunisFixados() {
  const orgId = useAuth().activeOrg?.orgId ?? null;
  const chave = orgId ? chaveDosFunisFixados(orgId) : null;
  const fixados = useSyncExternalStore(
    assinar,
    () => ler(chave),
    () => VAZIO,
  );

  const alternar = useCallback(
    (funil: FunilFixado): boolean => {
      if (!chave) return false;
      const atual = ler(chave);
      if (atual.some((f) => f.id === funil.id)) {
        gravar(chave, atual.filter((f) => f.id !== funil.id));
        return true;
      }
      if (atual.length >= MAXIMO_DE_FUNIS_FIXADOS) return false;
      gravar(chave, [...atual, funil]);
      return true;
    },
    [chave],
  );

  const renomear = useCallback(
    (funil: FunilFixado) => {
      const atual = ler(chave);
      if (atual.some((f) => f.id === funil.id && f.nome !== funil.nome)) {
        gravar(chave, atual.map((f) => (f.id === funil.id ? funil : f)));
      }
    },
    [chave],
  );

  return { fixados, alternar, renomear };
}
