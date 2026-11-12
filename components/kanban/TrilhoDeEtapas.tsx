"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useQueryClient } from "@tanstack/react-query";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { useMoveCard, type RecusaDeCampos, type RetomadaPendente } from "@/hooks/kanban/useMoveCard";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { pedeEscolhaDeReabertura } from "@/lib/leads/reabertura";
import { frenteSobreCor } from "@/lib/branding/contraste";
import type { BoardData, Stage } from "@/lib/kanban/types";
import { CamposObrigatoriosDialog } from "./CamposObrigatoriosDialog";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { RetomarComoNovoNegocioDialog } from "./RetomarComoNovoNegocioDialog";
import type { Lead } from "@/lib/types/leads";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const DIA_MS = 86_400_000;
const COR_PADRAO = "#94a3b8";

/** Seta com cantos arredondados (prévia `etapas-estallo`): entalhe à esquerda, ponta à direita. */
const SETA =
  "M5 1.5H122Q125 1.5 126.5 4.5L138 27.5Q139.3 30 138 32.5L126.5 55.5Q125 58.5 122 58.5H5Q2 58.5 3.4 55.7L14.8 32.5Q16 30 14.8 27.5L3.4 4.3Q2 1.5 5 1.5Z";
/** A primeira etapa não tem entalhe. */
const SETA_INICIAL =
  "M9 1.5H122Q125 1.5 126.5 4.5L138 27.5Q139.3 30 138 32.5L126.5 55.5Q125 58.5 122 58.5H9Q2 58.5 2 51.5V8.5Q2 1.5 9 1.5Z";

/**
 * As etapas do funil — abertas, ganho e perdido —, em fila, no topo do dossiê. Um clique move o
 * negócio pelo MESMO caminho do arrasto (`useMoveCard` → `/leads/{id}/move`,
 * com `expected_updated_at`): a recusa de campos obrigatórios abre o mesmo
 * diálogo do quadro e reenvia o mesmo move, em vez de virar toast de erro.
 * Ganho e perda também estão na fila (03/11/2026): quem vê o negócio num funil espera ver onde ele
 * termina. Ganho sai pelo mesmo move (com o diálogo de campos obrigatórios e motivo do ganho); perda
 * abre o diálogo do motivo, porque o servidor recusa fechar como perdido sem ele.
 *
 * OTIMISTA E SEM TRAVA. A etapa muda na tela no clique; o servidor confirma por
 * trás. Clicar de novo enquanto o primeiro move está em voo NÃO é ignorado: a
 * última escolha fica guardada e sai quando o move atual assentar, já com o
 * `updated_at` que ele devolveu (sem isso o segundo move levaria 409). Erro
 * descarta a fila, devolve a etapa anterior (rollback do `useMoveCard`) e mostra
 * o erro.
 *
 * Inativas levam a cor da etapa misturada ao fundo do painel; a atual, a cor
 * cheia — e o texto sobre ela sai de `frenteSobreCor` (azul ⇒ branco).
 */
export function TrilhoDeEtapas({
  lead,
  stages,
  pipelineId,
  podeMover,
}: {
  lead: Lead;
  stages: Stage[];
  pipelineId: string;
  podeMover: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [recusa, setRecusa] = useState<RecusaDeCampos | null>(null);
  const [retomada, setRetomada] = useState<RetomadaPendente | null>(null);
  const mover = useMoveCard(pipelineId, { onCamposFaltando: setRecusa });
  /** A etapa que a pessoa escolheu e a tela já mostra, até a fila esvaziar. */
  const [alvo, setAlvo] = useState<string | null>(null);
  const emVoo = useRef(false);
  const proxima = useRef<string | null>(null);
  const trilho = useRef<HTMLOListElement | null>(null);
  const atualRef = useRef<HTMLButtonElement | null>(null);
  const [rola, setRola] = useState({ transborda: false, inicio: true, fim: true });
  // Lido uma vez por abertura: contar dias não precisa de relógio vivo.
  const [agora] = useState(() => Date.now());
  const [perdendo, setPerdendo] = useState(false);
  // Todas as etapas ativas, na ordem do funil. O nome `abertas` ficou: é a fila que o trilho desenha.
  const abertas = stages.filter((s) => !s.is_archived);
  const atualId = alvo ?? lead.stage_id;
  const indiceAtual = abertas.findIndex((s) => s.id === atualId);
  const dias =
    lead.stage_changed_at && atualId === lead.stage_id
      ? Math.max(0, Math.floor((agora - new Date(lead.stage_changed_at).getTime()) / DIA_MS))
      : 0;

  const medir = useCallback(() => {
    const el = trilho.current;
    if (!el) return;
    setRola({
      transborda: el.scrollWidth > el.clientWidth + 1,
      inicio: el.scrollLeft <= 1,
      fim: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }, []);

  useLayoutEffect(() => {
    medir();
    const el = trilho.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [medir, abertas.length]);

  useEffect(() => {
    atualRef.current?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [atualId]);

  if (abertas.length === 0) return null;

  /** O lead como a cache do quadro o tem AGORA — `updated_at` fresco depois de cada move. */
  function leadNaCache(): Lead | undefined {
    return qc.getQueryData<BoardData>(chaveDoQuadro(pipelineId))?.leads.find((l) => l.id === lead.id);
  }

  function enviar(stageId: string) {
    const atual = leadNaCache() ?? lead;
    // O negócio entra no TOPO da etapa: antes do primeiro card dela.
    const primeiro = qc
      .getQueryData<BoardData>(chaveDoQuadro(pipelineId))
      ?.leads.filter((l) => l.stage_id === stageId && l.id !== lead.id)
      .reduce<number | null>((min, l) => (min === null || l.position_in_stage < min ? l.position_in_stage : min), null);
    emVoo.current = true;
    mover.mutate(
      {
        leadId: lead.id,
        stageId,
        positionInStage: midpoint(null, primeiro ?? null),
        expectedUpdatedAt: atual.updated_at,
      },
      {
        onSuccess: () => {
          const seguinte = proxima.current;
          proxima.current = null;
          if (seguinte && seguinte !== stageId) {
            enviar(seguinte);
            return;
          }
          emVoo.current = false;
          setAlvo(null);
          toast.success(t("Etapa atualizada."));
        },
        onError: () => {
          // A fila cai junto: a escolha seguinte partiu de um estado que não existe.
          proxima.current = null;
          emVoo.current = false;
          setAlvo(null);
        },
      },
    );
  }

  function escolher(stageId: string) {
    if (!podeMover || stageId === atualId) return;
    // Perda pede o motivo: o diálogo fecha o negócio pela rota própria (`/lose`).
    if (stages.find((s) => s.id === stageId)?.is_lost) {
      setPerdendo(true);
      return;
    }
    // Ganho/perdido levado a uma etapa aberta: primeiro a pergunta "Criar novo
    // lead × Mover lead existente" — a etapa só muda na tela se a escolha for mover.
    const atual = leadNaCache() ?? lead;
    if (pedeEscolhaDeReabertura(atual.status, stages.find((s) => s.id === stageId))) {
      setRetomada({
        leadId: lead.id,
        stageId,
        args: { leadId: lead.id, stageId, positionInStage: 0, expectedUpdatedAt: atual.updated_at },
      });
      return;
    }
    setAlvo(stageId);
    if (emVoo.current) {
      proxima.current = stageId;
      return;
    }
    enviar(stageId);
  }

  function rolar(sentido: 1 | -1) {
    const el = trilho.current;
    if (el) el.scrollBy({ left: sentido * el.clientWidth * 0.7, behavior: "smooth" });
  }

  const rotuloDias = dias === 1 ? t("1 dia") : `${dias} ${t("dias")}`;

  return (
    <section className="relative" data-testid="trilho-de-etapas" aria-label={t("Etapas do funil")}>
      <ol
        ref={trilho}
        onScroll={medir}
        className="-mx-[3px] flex snap-x snap-proximity overflow-x-auto overscroll-x-contain px-[3px] pt-[3px] pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {abertas.map((s, i) => {
          const atual = s.id === atualId;
          const cor = s.color ?? COR_PADRAO;
          return (
            <li
              key={s.id}
              className={cn(
                "relative min-w-[124px] flex-[1_0_124px] snap-center",
                i > 0 && "-ml-[7px]",
                atual && "z-[2]",
                "has-[:focus-visible]:z-[3]",
              )}
            >
              <button
                ref={atual ? atualRef : undefined}
                type="button"
                disabled={!podeMover}
                aria-current={atual ? "step" : undefined}
                onClick={() => escolher(s.id)}
                title={s.name}
                data-testid={`trilho-etapa-${s.id}`}
                data-atual={atual || undefined}
                className={cn(
                  "trilho-etapa group relative isolate flex h-14 w-full items-center justify-center py-1 pr-[13px] text-text focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                  i === 0 ? "pl-3" : "pl-[22px]",
                  podeMover && !atual && "cursor-pointer",
                )}
                style={{ "--etapa": cor, ...(atual ? { color: frenteSobreCor(cor) } : {}) } as CSSProperties}
              >
                <svg
                  className="absolute inset-0 -z-10 h-full w-full overflow-visible"
                  viewBox="0 0 140 60"
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <path d={i === 0 ? SETA_INICIAL : SETA} />
                </svg>
                <span
                  className={cn(
                    "pointer-events-none line-clamp-2 w-full min-w-0 text-center text-[11px] leading-[14px]",
                    atual ? "font-extrabold" : "font-semibold",
                  )}
                >
                  {s.name}
                </span>
              </button>
              {/* O TEMPO NA ETAPA mora FORA do chevron, logo abaixo da etapa
                  atual: dentro dele disputava as duas linhas do nome e
                  espremia o texto. A linha existe em TODA etapa (vazia nas
                  outras) para a altura do trilho não pular ao trocar de etapa. */}
              <span
                className="block min-h-5 overflow-x-clip pt-1 text-center text-[10px] font-semibold leading-4 text-ellipsis whitespace-nowrap text-text-muted"
                data-testid={atual ? "trilho-dias-na-etapa" : undefined}
              >
                {atual && lead.stage_changed_at && atualId === lead.stage_id ? `${rotuloDias} ${t("na etapa")}` : null}
              </span>
            </li>
          );
        })}
      </ol>
      {rola.transborda && (
        <div className="flex items-center justify-between gap-2 pt-1.5 text-[11px] text-text-muted">
          {/* Etapa arquivada não entra na fila: sem "Etapa 0/N". */}
          <span>
            {indiceAtual >= 0 ? (
              <>
                {t("Etapa")} <b className="text-text">{indiceAtual + 1}</b>/{abertas.length}
              </>
            ) : null}
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => rolar(-1)}
              disabled={rola.inicio}
              aria-label={t("Ver etapas anteriores")}
              className="flex h-[26px] w-7 items-center justify-center rounded-md border border-border-strong bg-surface hover:border-accent hover:text-accent disabled:opacity-30"
            >
              <CaretLeft size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => rolar(1)}
              disabled={rola.fim}
              aria-label={t("Ver próximas etapas")}
              className="flex h-[26px] w-7 items-center justify-center rounded-md border border-border-strong bg-surface hover:border-accent hover:text-accent disabled:opacity-30"
            >
              <CaretRight size={14} aria-hidden />
            </button>
          </div>
        </div>
      )}
      <CamposObrigatoriosDialog
        open={recusa !== null}
        onOpenChange={(aberto) => !aberto && setRecusa(null)}
        recusa={recusa}
        isPending={mover.isPending}
        onConfirmar={({ customFields, wonReason }) => {
          if (!recusa) return;
          const { args } = recusa;
          setRecusa(null);
          setAlvo(args.stageId);
          emVoo.current = true;
          mover.mutate(
            { ...args, customFields, ...(wonReason !== undefined ? { wonReason } : {}) },
            {
              onSettled: () => {
                emVoo.current = false;
                setAlvo(null);
              },
            },
          );
        }}
      />
      {perdendo && (
        <LoseLeadDialog open onOpenChange={(v: boolean) => !v && setPerdendo(false)} leadId={lead.id} pipelineId={pipelineId} />
      )}
      {retomada && (
        <RetomarComoNovoNegocioDialog
          open
          onOpenChange={(v: boolean) => !v && setRetomada(null)}
          leadId={retomada.leadId}
          stageId={retomada.stageId}
          pipelineId={pipelineId}
          onMoverEste={() => {
            const stageId = retomada.stageId;
            setRetomada(null);
            setAlvo(stageId);
            enviar(stageId);
          }}
        />
      )}
    </section>
  );
}
