"use client";

import { useMemo } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { projetarCaminho } from "@/lib/followup/caminho-no-grafo";
import { toReactFlow } from "@/lib/followup/graph-mappers";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PassoDaExecucao } from "@/lib/followup/passos-da-execucao";
import { useT } from "@/hooks/i18n/useT";

import { nodeTypes } from "../../../[id]/_components/nodes/node-types";

/** Anel por estado do passo. Bloco que a execução não visitou fica apagado — "não percorrido" se lê de longe. */
const ANEL: Record<string, string> = {
  succeeded: "ring-2 ring-success ring-offset-2 ring-offset-bg rounded-md",
  failed: "ring-2 ring-error ring-offset-2 ring-offset-bg rounded-md",
  skipped: "ring-2 ring-warning ring-offset-2 ring-offset-bg rounded-md",
  running: "ring-2 ring-accent-500 ring-offset-2 ring-offset-bg rounded-md",
};

interface OpcoesDoCanvas {
  /** Clique num bloco do desenho — o inspetor do editor abre o que aconteceu nele. */
  onSelecionarNo?: (nodeId: string) => void;
  noSelecionado?: string | null;
  /** Classe de altura; o dossiê usa 420px, o editor ocupa a área inteira. */
  altura?: string;
}

function Interno({
  grafo,
  passos,
  onSelecionarNo,
  noSelecionado = null,
  altura = "h-[420px]",
}: { grafo: Pick<FlowGraph, "nodes" | "edges">; passos: PassoDaExecucao[] } & OpcoesDoCanvas) {
  const t = useT();
  const { nodes, edges } = useMemo(() => {
    const base = toReactFlow({ nodes: grafo.nodes, edges: grafo.edges } as FlowGraph);
    const caminho = projetarCaminho(passos, grafo.edges);
    return {
      nodes: base.nodes.map((n) => {
        const estado = caminho.estadoDoNo.get(n.id);
        return {
          ...n,
          draggable: false,
          selectable: false,
          connectable: false,
          className: [
            estado ? (ANEL[estado] ?? ANEL.running) : "opacity-40",
            n.id === noSelecionado ? "outline outline-2 outline-offset-4 outline-accent-500 rounded-md" : "",
          ]
            .filter(Boolean)
            .join(" "),
          "data-estado": estado ?? "nao-percorrido",
        } as typeof n;
      }),
      edges: base.edges.map((e) => {
        const percorrida = caminho.arestasPercorridas.has(e.id);
        return {
          ...e,
          selectable: false,
          animated: percorrida,
          style: percorrida ? { stroke: "var(--color-accent-500, #2563eb)", strokeWidth: 3 } : { opacity: 0.25 },
        };
      }),
    };
  }, [grafo, passos, noSelecionado]);

  return (
    <div className={`${altura} w-full rounded-md border border-border`} data-testid="caminho-canvas" aria-label={t("Fluxo com o caminho percorrido")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes as NodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={onSelecionarNo ? (_e, no) => onSelecionarNo(no.id) : undefined}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/**
 * O fluxo como foi PINADO na execução, em modo de inspeção: os blocos percorridos com anel pelo estado (verde,
 * vermelho, amarelo), as ligações atravessadas em destaque, e tudo o mais apagado. Só para quem edita fluxos — o cartão
 * do bloco mostra a configuração dele.
 */
export function CaminhoNoCanvas({
  grafo,
  passos,
  ...opcoes
}: { grafo: Pick<FlowGraph, "nodes" | "edges">; passos: PassoDaExecucao[] } & OpcoesDoCanvas) {
  return (
    <ReactFlowProvider>
      <Interno grafo={grafo} passos={passos} {...opcoes} />
    </ReactFlowProvider>
  );
}
