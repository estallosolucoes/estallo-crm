"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { NodeType } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NODE_CATALOG, NODE_CATEGORIES, searchNodeTypes, type NodeCategory } from "@/lib/followup/node-catalog";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

interface Props {
  onAdd: (type: NodeType) => void;
  /**
   * Superfície do fluxo: a paleta oferece SÓ as caixas que o motor dela executa
   * (`NOS_DA_SUPERFICIE`, a mesma lista do publish). Na prova do #1130 a paleta
   * do roteiro oferecia seis caixas que o motor recusava em silêncio.
   */
  surface?: FollowupFlowSurface;
  /** "mobile" = mesmo conteúdo dentro do Sheet que `FlowCanvas` abre abaixo de
   * `lg` — a barra fixa de 224px não cabia perto do canvas num celular. */
  variant?: "desktop" | "mobile";
}

/**
 * Paleta (Fase 5): busca por nome, descrição e sinônimos (o MESMO catálogo do publish) e categorias recolhíveis.
 * As seções são `<details>` nativos — teclado e leitor de tela sem código extra. Clique ou arraste para inserir.
 */
export function NodePalette({ onAdd, variant = "desktop", surface = "followup" }: Props) {
  const t = useT();
  const isMobile = variant === "mobile";
  const [busca, setBusca] = useState("");
  const tipos = useMemo(
    () => (busca.trim() ? searchNodeTypes(surface, busca) : [...NOS_DA_SUPERFICIE[surface]]),
    [busca, surface],
  );
  const categorias = (Object.keys(NODE_CATEGORIES) as NodeCategory[])
    .map((categoria) => ({ categoria, itens: tipos.filter((tipo) => NODE_CATALOG[tipo].category === categoria) }))
    .filter((g) => g.itens.length > 0);

  return (
    <aside
      className={cn(
        isMobile ? "flex h-full w-full flex-col" : "relative hidden w-56 shrink-0 border-r border-border bg-surface lg:block",
      )}
      data-testid="node-palette"
    >
      {/* Desktop: o conteúdo é ABSOLUTO dentro do aside — não conta na altura da linha, ocupa a altura do canvas e rola
          por dentro. Uma paleta longa esticava a página e punha o canto do canvas debaixo do cabeçalho fixo. */}
      <div className={cn("flex flex-col gap-1.5 overflow-y-auto p-3", isMobile ? "h-full" : "absolute inset-0")}>
      <h2 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        {t("Adicionar nó")}
      </h2>
      <Input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder={t("Buscar bloco…")}
        aria-label={t("Buscar bloco")}
        className="mb-1 h-8 text-xs"
        data-testid="palette-busca"
      />
      {categorias.length === 0 && (
        <p className="px-1 text-xs text-text-muted" data-testid="palette-vazia">
          {t("Nenhum bloco encontrado.")}
        </p>
      )}
      {categorias.map(({ categoria, itens }) => (
        // `key` muda com a busca: buscar reabre as seções que alguém tinha recolhido.
        <details key={`${categoria}-${busca.trim() !== ""}`} open className="group" data-testid={`palette-categoria-${categoria}`}>
          <summary className="cursor-pointer select-none px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {t(NODE_CATEGORIES[categoria])}
          </summary>
          <div className="mt-1 flex flex-col gap-1.5">
            {itens.map((tipo) => {
              const visual = NODE_VISUALS[tipo];
              const Icon = visual.icon;
              return (
                <Button
                  key={visual.type}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="justify-start gap-2"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-followup-node-type", visual.type);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onAdd(visual.type)}
                  title={t(NODE_CATALOG[tipo].description)}
                  data-testid={`palette-add-${visual.type}`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${visual.chipClassName}`}
                  >
                    <Icon size={14} aria-hidden />
                  </span>
                  {t(visual.paletteLabel)}
                </Button>
              );
            })}
          </div>
        </details>
      ))}
      </div>
    </aside>
  );
}
