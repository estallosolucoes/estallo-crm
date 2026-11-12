"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { NoDoDossie } from "@/lib/followup/eventos-legiveis";
import { tipoDoNo } from "@/lib/followup/eventos-legiveis";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PassoDaExecucao } from "@/lib/followup/passos-da-execucao";
import { useT } from "@/hooks/i18n/useT";
import { DadosInspecionados } from "./DadosInspecionados";
import { cn } from "@/lib/utils";

/** O xyflow é pesado: só carrega quando a pessoa pede o desenho do fluxo. */
const CaminhoNoCanvas = dynamic(() => import("./CaminhoNoCanvas").then((m) => m.CaminhoNoCanvas), { ssr: false });

/** Como cada estado do diário aparece: texto, tom do selo e a cor da linha do passo. */
const ESTADO: Record<string, { rotulo: string; tom: "success" | "error" | "warning" | "neutral"; borda: string }> = {
  succeeded: { rotulo: "Concluído", tom: "success", borda: "border-l-success" },
  failed: { rotulo: "Falhou", tom: "error", borda: "border-l-error" },
  skipped: { rotulo: "Pulado", tom: "warning", borda: "border-l-warning" },
  running: { rotulo: "Em andamento", tom: "neutral", borda: "border-l-border-strong" },
};

function duracao(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return "< 1 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

export function Passo({
  passo,
  verDados,
  ramo,
  abertoInicial = false,
  configuracao,
}: {
  passo: PassoDaExecucao;
  verDados: boolean;
  ramo: string | null;
  /** Entrada e saída já abertas — o inspetor do editor mostra os dados de cara, sem exigir um clique a mais. */
  abertoInicial?: boolean;
  /** Configuração do bloco na versão fixada da execução; quando vem, ganha a sua própria seção. */
  configuracao?: unknown;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(abertoInicial);
  // Com mais de uma tentativa, a pessoa escolhe qual olhar; por padrão a última, que é a que decidiu o passo.
  const tentativas = passo.tentativas_detalhe ?? [];
  const [escolhida, setEscolhida] = useState<number | null>(null);
  const atual = tentativas.length > 1 ? (tentativas.find((x) => x.numero === escolhida) ?? tentativas[tentativas.length - 1]) : undefined;
  const erro = atual ? atual.erro : passo.erro;
  const entrada = atual ? atual.entrada : passo.entrada;
  const saida = atual ? atual.saida : passo.saida;
  const estado = ESTADO[passo.status] ?? {
    rotulo: passo.status,
    tom: "neutral" as const,
    borda: "border-l-border-strong",
  };
  const tempo = duracao(passo.duracao_ms);
  const temDados = verDados && (entrada !== undefined || saida !== undefined);

  return (
    <li className={cn("border-l-4 pl-3", estado.borda)} data-testid="caminho-passo" data-status={passo.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{passo.rotulo}</span>
        {passo.tipo && <span className="text-xs text-text-muted">{t(tipoDoNo(passo.tipo))}</span>}
        <Badge variant={estado.tom}>{t(estado.rotulo)}</Badge>
        {ramo && (
          <span className="text-xs text-text-muted" data-testid="caminho-ramo">
            {t("Seguiu por")} «{ramo}»
          </span>
        )}
        {tempo && <span className="text-xs text-text-muted">{tempo}</span>}
        {passo.tentativas > 1 && (
          <span className="text-xs text-text-muted">
            {passo.tentativas} {t("tentativas")}
          </span>
        )}
        {passo.visit > 0 && (
          <span className="text-xs text-text-muted">
            {t("volta")} {passo.visit + 1}
          </span>
        )}
      </div>
      {atual && (
        <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label={t("Tentativas deste passo")}>
          <span className="text-[11px] text-text-muted">{t("Tentativa")}</span>
          {tentativas.map((x) => (
            <button
              key={x.numero}
              type="button"
              data-testid="caminho-tentativa"
              aria-pressed={x.numero === atual.numero}
              onClick={() => setEscolhida(x.numero)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px]",
                x.numero === atual.numero ? "border-accent text-accent" : "border-border text-text-muted",
                x.status === "failed" && "border-error text-error-fg",
              )}
            >
              {x.numero}
            </button>
          ))}
        </div>
      )}
      {erro && (
        <p className="mt-1 text-xs text-error-fg" data-testid="caminho-erro">
          {erro}
        </p>
      )}
      {temDados && (
        <div className="mt-1">
          <button
            type="button"
            className="text-xs text-accent underline-offset-[3px] hover:underline"
            onClick={() => setAberto((v) => !v)}
            aria-expanded={aberto}
          >
            {aberto ? t("Esconder entrada e saída") : t("Ver entrada e saída")}
          </button>
          {aberto && (
            <div className={cn("mt-1 grid gap-2", configuracao === undefined ? "md:grid-cols-2" : "md:grid-cols-3")}>
              <div>
                <p className="mb-1 text-[11px] font-medium text-text-muted">{t("Entrada")}</p>
                <DadosInspecionados valor={entrada} origem="execucao" />
              </div>
              {configuracao !== undefined && (
                <div>
                  <p className="mb-1 text-[11px] font-medium text-text-muted">{t("Configuração")}</p>
                  <DadosInspecionados valor={configuracao} origem="configuracao" />
                </div>
              )}
              <div>
                <p className="mb-1 text-[11px] font-medium text-text-muted">{t("Saída")}</p>
                <DadosInspecionados valor={saida} origem="execucao" />
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * O caminho que ESTA execução percorreu: os passos em ordem, com o estado de cada um, a saída tomada, a duração e as
 * tentativas — e, separados, os nós do fluxo que ela não visitou. É o "histórico com o caminho percorrido" do plano
 * (Fase 3). Execução anterior ao diário não tem passos: a seção diz isso em vez de inventar um caminho.
 */
export function CaminhoPercorrido({
  passos,
  nos,
  arestas,
  verDados,
  grafo = null,
}: {
  passos: PassoDaExecucao[];
  nos: NoDoDossie[];
  arestas: Array<{ id: string; source: string; target: string }>;
  verDados: boolean;
  grafo?: Pick<FlowGraph, "nodes" | "edges"> | null;
}) {
  const t = useT();
  const [desenho, setDesenho] = useState(false);
  const visitados = new Set(passos.map((p) => p.node_id));
  const naoPercorridos = nos.filter((n) => !visitados.has(n.id));
  // O ramo tomado em cada nó: mostrado quando o próximo passo é mesmo destino de uma ligação desse nó.
  const ramoDe = (i: number): string | null => {
    const passo = passos[i];
    const proximo = passos[i + 1];
    if (!passo || !proximo || passo.branch_id === null || passo.branch_id === "else") return null;
    const ligado = arestas.some((a) => a.source === passo.node_id && a.target === proximo.node_id);
    return ligado ? passo.branch_id : null;
  };

  return (
    <section className="rounded-md border border-border p-4" data-testid="dossie-caminho">
      <div className="flex items-center justify-between gap-2">
        <h2 className="mb-1 text-sm font-medium">{t("Caminho percorrido")}</h2>
        {grafo && passos.length > 0 && (
          <button
            type="button"
            className="text-xs text-accent underline-offset-[3px] hover:underline"
            onClick={() => setDesenho((v) => !v)}
            aria-expanded={desenho}
            data-testid="caminho-ver-no-fluxo"
          >
            {desenho ? t("Esconder o desenho do fluxo") : t("Ver no desenho do fluxo")}
          </button>
        )}
      </div>
      {desenho && grafo && <div className="my-2"><CaminhoNoCanvas grafo={grafo} passos={passos} /></div>}
      {passos.length === 0 ? (
        <p className="py-2 text-sm text-text-muted" data-testid="caminho-vazio">
          {t("Esta execução é anterior ao registro passo a passo. O que aconteceu está na linha do tempo abaixo.")}
        </p>
      ) : (
        <ol className="space-y-3 py-2">
          {passos.map((p, i) => (
            <Passo key={p.step_id} passo={p} verDados={verDados} ramo={ramoDe(i)} />
          ))}
        </ol>
      )}
      {passos.length > 0 && naoPercorridos.length > 0 && (
        <div className="mt-2" data-testid="caminho-nao-percorridos">
          <p className="mb-1 text-xs font-medium text-text-muted">{t("Não percorridos nesta execução")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {naoPercorridos.map((n) => (
              <li key={n.id} className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-text-muted">
                {n.rotulo}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
