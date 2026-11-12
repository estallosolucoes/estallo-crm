"use client";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { CalendarBlank } from "@/lib/ui/icons";
import { IconeWhatsapp } from "@/components/chat-suspenso/IconeWhatsapp";
import { useChatSuspenso } from "@/components/chat-suspenso/ChatSuspensoContext";
import { Draggable } from "@hello-pangea/dnd";
import { memo, useMemo, useRef, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { opcoesDaTimeline } from "@/hooks/leads/useLeadTimeline";
import { opcoesDosProdutosDoNegocio } from "@/hooks/leads/useProdutosDoNegocio";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { Lead } from "@/lib/types/leads";
import { buildCardInput, resolveCardState, stageAgeLabel } from "@/lib/kanban/card-state";
import { KanbanCardActions } from "./KanbanCardActions";
import { NextActionSlot } from "./NextActionSlot";
import { ReactivationSlot } from "./ReactivationSlot";
import { ConversaSlot } from "./ConversaSlot";
import { ScoreSlot } from "./ScoreSlot";
import { OwnerBadge } from "./OwnerBadge";
import { ContatoNoCard } from "./ContatoNoCard";
import { TarefasNoCard } from "./TarefasNoCard";

/** Os dois gestos de seleção que o card sabe relatar. */
export type GestoDeSelecao = "alterna" | "intervalo";

interface KanbanCardProps {
  /** A linha do lead. O que o card MOSTRA sai dela por `buildCardInput`. */
  lead: Lead;
  stageName: string;
  ownerNames?: Map<string, string | null>;
  coolingIds?: Set<string>;
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  canonicalTags?: string[];
  index: number;
  pipelineId: string;
  isSelected?: boolean;
  /**
   * Há seleção viva no quadro. Só muda a VISIBILIDADE da caixa (que fora disso
   * aparece no hover/foco): quando o usuário já está selecionando, esconder as
   * caixas dos outros cards transforma "clicar em mais um" numa caça ao pixel.
   */
  isSelecting?: boolean;
  /**
   * Contador de pulsos deste card (evento REMOTO). Muda a cada evento novo — é
   * a MUDANÇA que remonta o overlay e reinicia a animação; um booleano deixaria
   * o segundo evento dentro da janela passar despercebido.
   */
  pulseCount?: number;
  /**
   * `alterna` = um card entra/sai da seleção. `intervalo` = daqui até a âncora
   * (shift). Quem resolve o intervalo é a COLUNA, que é a única que conhece a
   * ordem visível dos cards — o card só relata o gesto.
   */
  onSelect?: (leadId: string, gesto: GestoDeSelecao) => void;
  /** Abrir o dossiê. Separado de `onSelect`: são gestos e intenções diferentes. */
  onOpen?: (leadId: string) => void;
}

function formatValor(cents: number | null, currency: string | null): string | null {
  // A régua do negócio (×100 em qualquer moeda) e o locale da moeda moram em
  // `formatValorDoNegocio` — a mesma função do total da coluna, para o card e o
  // topo da coluna nunca escreverem o mesmo dinheiro de dois jeitos.
  if (cents == null) return null;
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/** Card do funil: identidade, etiquetas, valor, conversa e responsável sempre à vista. */
export const KanbanCard = memo(function KanbanCard({
  lead,
  stageName,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  index,
  pipelineId,
  isSelected,
  isSelecting = false,
  pulseCount = 0,
  onSelect,
  onOpen,
}: KanbanCardProps) {
  const t = useT();
  const chatSuspenso = useChatSuspenso();
  // MEMO: num funil de mil cards, qualquer estado do quadro (abrir o dossiê,
  // um pulso, marcar um card) re-renderizava TODOS. O card só refaz quando o
  // próprio lead (o cache do quadro preserva a referência do que não mudou) ou
  // o contexto dele muda.
  const card = useMemo(
    () => buildCardInput(lead, { stageName, ownerNames, coolingIds, reactivations, canonicalTags }),
    [lead, stageName, ownerNames, coolingIds, reactivations, canonicalTags],
  );
  const value = formatValor(card.valueCents, card.currency);
  const state = resolveCardState(card, t);
  const age = stageAgeLabel(card.hoursInStage, t);

  // Clique ABRE o dossiê; ctrl/cmd+clique SELECIONA; shift+clique estende até a
  // âncora. "Clicar abre" é a convenção mais forte, e seleção múltipla é recurso
  // de poder, que tolera modificador. O arrasto continua funcionando porque o
  // dnd distingue clique de arrasto por movimento, não por handler.
  //
  // A CAIXA abaixo existe porque modificador não se descobre: até ela, a única
  // porta para o lote era saber que ctrl+clique fazia algo — e um recurso que
  // só quem já sabe encontra não é recurso, é folclore.
  //
  // ⚠️ UMA função, dois pontos de entrada — e a duplicação que existia aqui
  // custou o recurso inteiro no alvo mais óbvio. O TÍTULO é um `<button>` com
  // `stopPropagation()` (ver abaixo), então o clique nele NUNCA chega a este
  // handler; e o `onClick` do título ignorava os modificadores e abria o dossiê
  // sempre. Medido pela tela em 2026-09-04, com 6 cards e a âncora no 2º:
  //
  //   shift+clique no TÍTULO do 5º  → 1 marcado, 1 diálogo aberto (o dossiê)
  //   shift+clique no CORPO  do 5º  → 4 marcados, 0 diálogos
  //
  // O título é o maior e mais natural alvo do card. Quem lê "Segurando Shift,
  // um clique seleciona tudo entre o card anterior e o que você clicou" e clica
  // no card clica no nome dele — e recebia o dossiê.
  const decidirClique = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void => {
    if (e.shiftKey) {
      onSelect?.(card.id, "intervalo");
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onSelect?.(card.id, "alterna");
      return;
    }
    onOpen?.(card.id);
  };
  const handleClick = (e: MouseEvent<HTMLDivElement>) => decidirClique(e);

  // PREFETCH DO DOSSIÊ: parar o ponteiro (ou o foco) no card por um instante
  // já busca as seções mais pesadas do dossiê — a timeline e os produtos —,
  // então o clique abre com elas prontas. O atraso evita buscar a cada card
  // que o mouse só atravessa; `prefetchQuery` não repete o que está fresco.
  const qc = useQueryClient();
  const prefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agendarPrefetch = () => {
    if (prefetch.current) return;
    prefetch.current = setTimeout(() => {
      void qc.prefetchQuery(opcoesDaTimeline(card.id));
      void qc.prefetchQuery(opcoesDosProdutosDoNegocio(card.id));
    }, 150);
  };
  const cancelarPrefetch = () => {
    if (prefetch.current) clearTimeout(prefetch.current);
    prefetch.current = null;
  };

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          // O dnd marca o handle como role="button"; com o menu de ações dentro,
          // isso vira nested-interactive no axe. "group" mantém o foco e o
          // teclado do dnd (tabIndex e handlers continuam vindo do spread) sem
          // aninhar dois controles — nada de aria-hidden nem de suprimir regra.
          role="group"
          aria-label={`${t("Lead")}: ${card.title}`}
          onClick={handleClick}
          onPointerEnter={agendarPrefetch}
          onPointerLeave={cancelarPrefetch}
          onFocus={agendarPrefetch}
          onBlur={cancelarPrefetch}
          // O título nativo também permite ler etiquetas truncadas.
          title={card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : undefined}
          className={cn(
            "group relative overflow-hidden rounded-2xl border border-border/70 bg-surface",
            "p-3 shadow-md transition-[border-color,box-shadow]",
            "hover:border-border-strong",
            snapshot.isDragging && "rotate-1 shadow-md ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
          )}
        >
          {/* key = contador: cada evento remoto monta um overlay NOVO, e é isso
              que reinicia a animação. Fica no elemento interno — pôr no wrapper
              remontaria o draggable e quebraria o arrasto. */}
          {pulseCount > 0 && (
            <span
              key={pulseCount}
              aria-hidden
              // Observável de propósito: é assim que o teste prova que o
              // overlay REMONTOU (contador novo) em vez de ter sobrado do
              // evento anterior — e "sobrou" era exatamente o defeito.
              data-pulse={pulseCount}
              className="card-pulse pointer-events-none absolute inset-0"
            />
          )}
          {/* A borda sinaliza uma ação pendente, além das etiquetas do lead. */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-0.5",
              state.border === "accent" && "bg-accent",
              state.border === "warning" && "bg-warning",
              state.border === "neutral" && "bg-transparent",
            )}
          />

          <div className="flex items-start gap-2.5">
            <div className="relative shrink-0">
              <Avatar className="size-9">
                {lead.contact_has_avatar && lead.contact_id && (
                  <AvatarImage
                    src={`/api/v1/contacts/${lead.contact_id}/avatar`}
                    alt=""
                    className="object-cover"
                  />
                )}
                <AvatarFallback className="bg-accent-soft text-sm font-semibold text-accent">
                  {(lead.contact_name || card.title).trim().slice(0, 1).toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <input
                type="checkbox"
                checked={Boolean(isSelected)}
                aria-label={`${t("Selecionar")}: ${card.title}`}
                onClick={(e) => {
                  // O card inteiro tem onClick (abre o dossiê): sem parar a
                  // propagação, marcar a caixa abriria o dossiê por cima.
                  e.stopPropagation();
                  onSelect?.(card.id, e.shiftKey ? "intervalo" : "alterna");
                }}
                onChange={() => {
                  /* estado vem de `isSelected`; quem decide é o onClick acima */
                }}
                className={cn(
                  "absolute -top-1 -left-1 z-10 h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
                  "focus:opacity-100 focus-visible:outline-2 focus-visible:outline-accent",
                  isSelected || isSelecting ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="line-clamp-2 text-sm leading-5 font-bold text-text">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    decidirClique(e);
                  }}
                  className="text-left hover:underline"
                >
                  {card.title}
                </button>
              </h3>
              {card.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t("Tags do lead")}>
                  {card.tags.map((tag) => (
                    <ChipDeEtiqueta
                      key={tag}
                      tag={tag}
                      entidade="lead"
                      className="max-w-full truncate rounded-full px-2 py-0.5 text-xs"
                    />
                  ))}
                </div>
              )}
            </div>
            <KanbanCardActions lead={lead} pipelineId={pipelineId} />
          </div>

          {/* Valor em destaque; ausência de valor continua explícita. */}
          <p
            className={cn(
              "mt-2 text-base font-bold tabular-nums",
              value ? "text-text" : "text-text-muted",
            )}
          >
            {value ?? "—"}
          </p>

          {/* ③ a linha do agente — um slot, três estados, nunca três blocos. */}
          <div
            className={cn(
              "mt-2 flex min-h-6 items-center gap-2 text-xs",
              state.slot.type === "idle" && "hidden",
            )}
          >
            {state.slot.type === "awaiting" && (
              // A proposta do agente é a ÚNICA linha do card com ação: é o
              // ponto onde a decisão do humano entra. Sem os botões aqui, o
              // texto seria só mais um aviso — e a wave existe porque avisar
              // sem poder decidir é o que já acontecia (o dado ficava no banco).
              <NextActionSlot
                label={state.slot.label}
                leadId={card.id}
                approvedSeq={lead.next_action?.seq ?? -1}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "reactivation" && (
              // O negócio parou E aqui está o que fazer. Mesma faixa, mesma
              // altura: o card não cresce quando o sistema tem algo a propor.
              <ReactivationSlot
                leadId={card.id}
                proposalId={state.slot.proposalId}
                expiresAt={state.slot.expiresAt}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "cooling" && (
              // -fg é a variante de TEXTO do token (o -warning puro dá 3.7:1 em
              // 12px); a cor cheia fica na borda de estado, que é gráfica.
              <span className="truncate text-warning-fg">{state.slot.label}</span>
            )}
            {state.slot.type === "meter" && (
              <ScoreSlot
                probability={state.slot.probability}
                band={state.slot.band}
                reason={state.slot.reason}
                factors={state.slot.factors}
              />
            )}
          </div>

          {/* A última mensagem, com atalho para o inbox. Fica ANTES do rodapé
              de dono/tempo porque é conteúdo do negócio, não metadado do card —
              e some por inteiro quando não há conversa. */}
          <ConversaSlot
            conversa={lead.conversa}
            contactId={lead.contact_id}
            phone={lead.contact_phone}
          />

          {/* Telefone, e-mail e links do contato — some por inteiro quando o
              negócio não tem nada disso, como a conversa acima. */}
          <ContatoNoCard lead={lead} />

          {/* ④ dono (+ selo de tarefas) · ⑤ tempo no estágio */}
          <div className="mt-2 flex min-h-8 items-center justify-between gap-2 border-t border-border/60 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <OwnerBadge
                ownerKind={card.owner.kind}
                ownerName={card.owner.name}
                agentVersion={card.owner.agentVersion}
              />
              <TarefasNoCard tarefas={lead.tarefas} />
            </div>
            <span
              className="ml-auto inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-elevated px-2 py-1 text-xs text-text-muted"
              title={`${age ?? ""} ${t("em")} ${card.stageName}`}
            >
              <CalendarBlank size={13} className="shrink-0" aria-hidden />
              <span className="truncate">
                {state.showStageAge && age
                  ? `${age} ${t("em")} ${card.stageName}`
                  : `${t("em")} ${card.stageName}`}
              </span>
            </span>
            {lead.conversa?.channel === "whatsapp" &&
              (chatSuspenso ? (
                // Abre a conversa no CHAT SUSPENSO, sem sair do funil. Fora da
                // casca (teste de componente, tela pública) cai no link de antes.
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    chatSuspenso.abrir(lead.conversa!.id);
                  }}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-fg hover:bg-success-bg/70"
                  aria-label={t("Abrir WhatsApp")}
                  title={t("Conversar sem sair do funil")}
                >
                  <IconeWhatsapp size={18} />
                </button>
              ) : (
                <Link
                  href={`/app/inbox?id=${lead.conversa.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-fg hover:bg-success-bg/70"
                  aria-label={t("Abrir WhatsApp")}
                  title={t("Abrir esta conversa no Inbox")}
                >
                  <IconeWhatsapp size={18} />
                </Link>
              ))}
          </div>
        </div>
      )}
    </Draggable>
  );
});
