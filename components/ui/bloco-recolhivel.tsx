"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

import { CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const CHAVE = (id: string) => `painel:${id}`;

function assinar(avisar: () => void) {
  window.addEventListener("storage", avisar);
  return () => window.removeEventListener("storage", avisar);
}

function lerAberto(id: string, padrao: boolean): boolean {
  try {
    const v = window.localStorage.getItem(CHAVE(id));
    return v === null ? padrao : v === "1";
  } catch {
    return padrao;
  }
}

/**
 * Uma seção de painel lateral (inbox, dossiê do lead): borda, cabeçalho com
 * ícone, título e contagem, e seta para recolher. Recolher é lembrado por
 * navegador (localStorage) — conveniência de quem usa, não estado do produto.
 */
export function BlocoRecolhivel({
  id,
  titulo,
  icone,
  contagem,
  acoes,
  abertoPorPadrao = true,
  manterMontado = false,
  className,
  children,
  ...resto
}: {
  id: string;
  titulo: string;
  icone?: ReactNode;
  contagem?: number | null;
  acoes?: ReactNode;
  abertoPorPadrao?: boolean;
  /**
   * Recolhido continua MONTADO (só escondido). Para conteúdo com estado que
   * não pode se perder ao recolher — a ficha do lead com alteração não salva.
   */
  manterMontado?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  // O servidor (e a hidratação) desenham o padrão; o navegador lê o salvo.
  const salvo = useSyncExternalStore(assinar, () => lerAberto(id, abertoPorPadrao), () => abertoPorPadrao);
  const [escolhido, setEscolhido] = useState<boolean | null>(null);
  const aberto = escolhido ?? salvo;

  function alternar() {
    const novo = !aberto;
    try {
      window.localStorage.setItem(CHAVE(id), novo ? "1" : "0");
    } catch {
      // sem armazenamento: só não lembra
    }
    setEscolhido(novo);
  }

  return (
    <section
      className={cn("shrink-0 overflow-hidden rounded-[14px] border border-border bg-card shadow-xs", className)}
      data-bloco={id}
      {...resto}
    >
      <div className="flex min-h-[34px] items-center gap-2 bg-muted/40 px-3 py-2">
        <button
          type="button"
          onClick={alternar}
          aria-expanded={aberto}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {icone && <span className="shrink-0 text-accent">{icone}</span>}
          <h3 className="truncate font-sans text-xs font-semibold text-text">{titulo}</h3>
          {contagem != null && contagem > 0 && (
            <span className="rounded-full bg-background px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {contagem}
            </span>
          )}
          <CaretDown
            size={12}
            className={cn("ml-auto shrink-0 text-muted-foreground transition-transform", !aberto && "-rotate-90")}
            aria-hidden
          />
        </button>
        {acoes}
      </div>
      {(aberto || manterMontado) && (
        <div className="border-t border-border p-3" hidden={!aberto}>
          {children}
        </div>
      )}
    </section>
  );
}
