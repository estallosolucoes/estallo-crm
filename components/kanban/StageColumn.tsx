"use client";
import { Button } from "@/components/ui/button";
import { ListChecks, Plus } from "@/lib/ui/icons";
import { Droppable } from "@hello-pangea/dnd";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { estiloDoChip } from "@/lib/tags/cor-da-etiqueta";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { intervaloDaColuna } from "@/lib/kanban/selecao";
import { formatSomaPorMoeda, formatValorDoNegocio, MOEDA_PADRAO, somaPorMoeda } from "@/lib/money";
import { KanbanCard, type GestoDeSelecao } from "./KanbanCard";

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  pipelineId: string;
  /** owner_user_id → nome, resolvido no board. O dono agente vem no lead. */
  ownerNames?: Map<string, string | null>;
  /** ids que o radar classificou como esfriando (fonte única, não recalculada). */
  coolingIds?: Set<string>;
  /** Propostas de retomada vivas, por lead. */
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  /** `settings.canonical_tags` do pipeline — a única tag que fica no card. */
  canonicalTags?: string[];
  selectedLeadIds?: Set<string>;
  /** leadId → quantos eventos remotos já chegaram (muda = pulsa de novo). */
  pulses?: Map<string, number>;
  /**
   * Marca/desmarca um conjunto de uma vez — a etapa inteira, ou o intervalo do
   * shift+clique. Existe separado de `onSelect` porque a coluna é a única que
   * sabe a ordem VISÍVEL dos cards (é ela que recebe a lista já filtrada), e
   * resolver o intervalo no board significaria reconstruir essa ordem lá.
   */
  onSelectMany?: (leadIds: string[], marcar: boolean) => void;
  /** Abrir o dossiê — atravessa o board até o card, como `pulses`. */
  onOpen?: (leadId: string) => void;
  onAddLead?: (stageId: string) => void;
  /** `manager`+ — mesmo corte de papel da rota que renomeia a etapa. */
  podeRenomear?: boolean;
  onRenomear?: (nome: string) => void;
}

/**
 * Quantos cards a coluna desenha de cada vez. Os seguintes entram quando o fim
 * da lista chega perto da tela — um funil de mil negócios desenhava mil cards
 * de saída, e o scroll do quadro arrastava.
 */
const LOTE_DE_CARDS = 30;

export const StageColumn = memo(function StageColumn({
  stage,
  leads,
  pipelineId,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  selectedLeadIds,
  pulses,
  onSelectMany,
  onOpen,
  onAddLead,
  podeRenomear = false,
  onRenomear,
}: StageColumnProps) {
  const t = useT();
  // O TOTAL É POR MOEDA (#1531). Antes ele somava todos os `value_cents` e
  // escrevia o resultado na moeda do primeiro negócio: R$ 5.000 e 5.000 € saíam
  // "R$ 10.000,00", um valor que não existe. Agora cada moeda tem o seu total,
  // lado a lado e sem conversão ("R$ 5.000,00 + 5000,00 €"). Com uma moeda só o
  // texto é exatamente o de antes — é o caso comum, e nele nada muda. (Antes
  // disso, o total saía SEMPRE em R$ por um `formatBRL` local com a moeda em
  // duro; `formatValorDoNegocio` é a fonte única e a régua ×100 do negócio.)
  //
  // `currency` NULL conta como `MOEDA_PADRAO`, porque é o que o card mostra
  // (`KanbanCard`): o total não pode discordar do card que está logo abaixo.
  const moedaDoLead = (l: Lead) => l.currency ?? MOEDA_PADRAO;
  const totais = somaPorMoeda(leads, (l) => l.value_cents, moedaDoLead);
  // A ordem: primeiro a moeda com MAIS NEGÓCIOS COM VALOR na coluna (empate em
  // ordem alfabética), depois as demais em ordem alfabética. Conta negócios, não
  // soma valores — "mais valor" compararia centavos de moedas diferentes, o
  // mesmo erro que esta regra acaba. E não depende da posição dos cards: mover
  // um card na coluna não embaralha o cabeçalho.
  //
  // ponytail: o ideal é a moeda da ORGANIZAÇÃO primeiro, mas ela não chega ao
  // quadro (`ActiveOrg` traz o fuso e não a moeda). Como o negócio nasce na
  // moeda da organização (API e conversa), a mais frequente é, na prática, ela;
  // numa organização anterior a isso, os negócios antigos em BRL podem ganhar.
  // Upgrade: `currency` no embed `organizations(...)` de `lib/auth/server.ts`,
  // em `ActiveOrg`, e daí page → `PipelinePageClient` → `KanbanBoard` → uma prop
  // aqui que substitui `primeira`.
  const primeira = [
    ...somaPorMoeda(leads, (l) => (l.value_cents == null ? null : 1), moedaDoLead),
  ].sort(([ma, na], [mb, nb]) => nb - na || ma.localeCompare(mb))[0]?.[0];
  // A faixa aparece quando alguma moeda soma mais de zero — o `total > 0` de
  // antes, por moeda. Coluna sem valor nenhum não mostra "R$ 0,00".
  const temTotal = [...totais.values()].some((cents) => cents > 0);

  // A linha "ponderado" (issue #1535): o que ESTA coluna representa quando a
  // etapa tem chance calibrada. Ganho e perda valem 100 e 0 NA REGRA
  // (`lib/leads/previsao.ts`), não na coluna. `null` = etapa sem calibração, e
  // aí a linha não aparece: exibir "R$ 0,00" seria um número que ninguém
  // calibrou lendo como uma promessa de zero.
  //
  // Também por moeda, com a mesma função de moeda e a mesma `primeira` do total:
  // mesmas moedas, na mesma ordem. Arredonda por negócio, como antes.
  const probDaColuna = stage.is_won ? 100 : stage.is_lost ? 0 : (stage.win_probability ?? null);
  const ponderados =
    probDaColuna === null
      ? null
      : somaPorMoeda(
          leads,
          (l) => (l.value_cents == null ? null : Math.round((l.value_cents * probDaColuna) / 100)),
          moedaDoLead,
        );

  const idsVisiveis = leads.map((l) => l.id);
  const selecionadosAqui = idsVisiveis.filter((id) => selectedLeadIds?.has(id)).length;
  const todosSelecionados = idsVisiveis.length > 0 && selecionadosAqui === idsVisiveis.length;

  // A âncora do shift+clique. `useRef` e não `useState` de propósito: mudar a
  // âncora não muda nada na tela, e um `setState` aqui remontaria a coluna
  // inteira — inclusive o `Droppable` — a cada card marcado.
  const ancora = useRef<string | null>(null);

  // ESTÁVEL de propósito: é prop de todo card (memoizado). Lê a lista e a
  // seleção do render mais recente por ref, em vez de nascer de novo a cada um.
  const atual = useRef({ idsVisiveis, selectedLeadIds, onSelectMany });
  useLayoutEffect(() => {
    atual.current = { idsVisiveis, selectedLeadIds, onSelectMany };
  });
  const aoSelecionar = useCallback((leadId: string, gesto: GestoDeSelecao) => {
    const { idsVisiveis: ids, selectedLeadIds: sel, onSelectMany: marcar } = atual.current;
    if (gesto === "intervalo") {
      const faixa = intervaloDaColuna(ids, ancora.current, leadId);
      ancora.current = leadId;
      marcar?.(faixa, true);
      return;
    }
    ancora.current = leadId;
    marcar?.([leadId], !sel?.has(leadId));
  }, []);

  // Os cards entram em lotes (LOTE_DE_CARDS). A lista desenhada é sempre um
  // PREFIXO da lista da etapa, então o índice do arrasto continua apontando o
  // mesmo vizinho — e o de baixo vem da etapa inteira (`proximoNaEtapaInteira`).
  // Total, contagem e "selecionar todos" seguem contando a etapa inteira.
  const [limite, setLimite] = useState(LOTE_DE_CARDS);
  const fimDaLista = useRef<HTMLDivElement | null>(null);
  const temMais = leads.length > limite;
  useEffect(() => {
    const alvo = fimDaLista.current;
    if (!temMais || !alvo || typeof IntersectionObserver === "undefined") return;
    const observador = new IntersectionObserver(
      (entradas) => {
        if (entradas.some((e) => e.isIntersecting)) setLimite((n) => n + LOTE_DE_CARDS);
      },
      { rootMargin: "800px 0px" },
    );
    observador.observe(alvo);
    return () => observador.disconnect();
  }, [temMais, limite]);
  const visiveis = temMais ? leads.slice(0, limite) : leads;
  const selecionando = (selectedLeadIds?.size ?? 0) > 0;

  const alternarEtapa = () => {
    ancora.current = null;
    onSelectMany?.(idsVisiveis, !todosSelecionados);
  };

  return (
    <div
      /*
        `w-[85vw] max-w-[320px] snap-center md:w-[320px]` — a coluna cabe na tela
        do celular, e uma por vez; 85vw deixa a sobra onde a coluna seguinte se
        anuncia, e `snap-center` para a rolagem nela. Do `md` para cima, 320px
        (era 360): em tela pequena cabia uma etapa e meia.
      */
      className="flex min-h-full w-[85vw] max-w-[320px] shrink-0 snap-center flex-col md:w-[320px]"
      data-etapa-do-quadro={stage.id}
    >
      {/*
        O TÍTULO SOLTO, ACIMA DA MOLDURA (modelo do dono, 17/10/2026): a pílula
        com a cor da etapa (Configurações › Funis) e, à direita, o total e a
        contagem. Preso no alto enquanto os cards rolam — com uma etapa
        comprida, é o que diz em que etapa se está olhando. O fundo opaco é o da
        página, para os cards não aparecerem por baixo.

        O texto da pílula sai de `estiloDoChip`, a mesma régua das etiquetas:
        preto ou branco pelo contraste com a cor, nunca branco fixo.
      */}
      <div className="sticky top-0 z-10 bg-background pb-2" data-cabecalho-da-etapa>
        <div className="group/etapa flex items-center gap-2 px-0.5 pt-0.5">
          {/* "Selecionar a etapa inteira": fica no cabeçalho porque é ali que a
              etapa é um objeto. Indeterminado quando a seleção é parcial. */}
          <input
            type="checkbox"
            checked={todosSelecionados}
            ref={(el) => {
              if (el) el.indeterminate = selecionadosAqui > 0 && !todosSelecionados;
            }}
            disabled={idsVisiveis.length === 0}
            onChange={alternarEtapa}
            aria-label={
              todosSelecionados
                ? `${t("Desmarcar todos em")} ${stage.name}`
                : `${t("Selecionar todos em")} ${stage.name}`
            }
            className={cn(
              "h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
              "focus:opacity-100 disabled:cursor-default",
              // No toque o hover nunca acontece (ver KanbanCard).
              selecionadosAqui > 0
                ? "opacity-100"
                : "opacity-0 group-hover/etapa:opacity-100 pointer-coarse:opacity-100",
            )}
          />
          <h2
            className={cn(
              "flex min-w-0 max-w-[70%] items-center rounded-full border px-3 py-1 text-sm font-semibold",
              !estiloDoChip(stage.color) && "border-border bg-surface-elevated text-text",
            )}
            style={estiloDoChip(stage.color)}
          >
            {podeRenomear && onRenomear ? (
              // `key` pelo nome: remonta (e descarta o rascunho) quando o nome
              // GRAVADO muda — mesmo contrato de `NomeDaEtapa` em Configurações.
              <NomeDaEtapaNoQuadro key={stage.name} nome={stage.name} onConfirmar={onRenomear} />
            ) : (
              <span className="truncate">{stage.name}</span>
            )}
          </h2>
          <span className="ml-auto flex min-w-0 flex-col items-end text-right leading-tight tabular-nums">
            {temTotal && (
              <span className="truncate text-xs font-semibold text-text">
                {formatSomaPorMoeda(totais, formatValorDoNegocio, { primeira })}
              </span>
            )}
            <span className="text-[11px] text-text-muted">
              ({selecionadosAqui > 0 ? `${selecionadosAqui}/${leads.length}` : leads.length})
            </span>
            {temTotal && ponderados !== null && (
              <span className="truncate text-[11px] text-text-muted">
                {t("ponderado")} {formatSomaPorMoeda(ponderados, formatValorDoNegocio, { primeira })}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* A MOLDURA da etapa — neutra; a cor mora no título. */}
      <div className="flex flex-1 flex-col rounded-2xl border border-border bg-background">
      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex flex-1 flex-col gap-2.5 p-2 transition-colors",
              snapshot.isDraggingOver && "bg-accent/5",
            )}
          >
            {visiveis.map((lead, idx) => (
              <KanbanCard
                key={lead.id}
                lead={lead}
                stageName={stage.name}
                ownerNames={ownerNames}
                coolingIds={coolingIds}
                reactivations={reactivations}
                canonicalTags={canonicalTags}
                index={idx}
                pipelineId={pipelineId}
                isSelected={selectedLeadIds?.has(lead.id) ?? false}
                isSelecting={selecionando}
                pulseCount={pulses?.get(lead.id) ?? 0}
                onSelect={aoSelecionar}
                onOpen={onOpen}
              />
            ))}
            {provided.placeholder}
            {temMais && (
              <div
                ref={fimDaLista}
                className="flex h-8 items-center justify-center text-xs text-text-muted"
                data-testid="coluna-carrega-mais"
              >
                {t("Carregando…")}
              </div>
            )}
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex min-h-64 flex-1 flex-col items-center justify-center px-4 py-8 text-center">
                <span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <ListChecks size={28} aria-hidden />
                </span>
                <p className="text-base font-bold text-text">{t("Nenhum lead nesta etapa")}</p>
                <p className="mt-2 max-w-60 text-sm leading-relaxed text-text-muted">
                  {t("Quando um lead avançar para esta etapa, ele aparecerá aqui.")}
                </p>
                {onAddLead && (
                  <Button
                    className="mt-5 rounded-lg px-4 shadow-md"
                    onClick={() => onAddLead(stage.id)}
                  >
                    <Plus size={16} aria-hidden />
                    {t("Adicionar lead")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Droppable>
      </div>
    </div>
  );
});

/**
 * O nome da etapa, editado no lugar — direto no cabeçalho da coluna.
 *
 * Mesmo contrato de `NomeDaEtapa` (Configurações › Funis, que chama a MESMA
 * rota `PATCH /api/v1/pipelines/:id/stages/:stageId`): salva ao CONFIRMAR
 * (Enter ou sair do campo), nunca a cada tecla — um PATCH por caractere
 * dispararia a validação de nome duplicado no meio da digitação. O rascunho é
 * local; o `key={stage.name}` de quem chama remonta o campo quando o nome
 * GRAVADO muda, então uma edição feita em outra aba não fica escondida atrás
 * de um rascunho velho.
 */
function NomeDaEtapaNoQuadro({
  nome,
  onConfirmar,
}: {
  nome: string;
  onConfirmar: (nome: string) => void;
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState(nome);
  // O Escape desfoca, e o desfoque chama `confirmar` na MESMA tecla: o
  // `rascunho` que ele lê ainda é o texto digitado, e sem esta marca o Escape
  // salvava o que devia desfazer (medido em renomear-etapa-no-quadro.test.tsx).
  const cancelado = useRef(false);

  function confirmar() {
    const limpo = rascunho.trim();
    if (cancelado.current || !limpo || limpo === nome) {
      cancelado.current = false;
      setRascunho(nome);
      return;
    }
    onConfirmar(limpo);
  }

  return (
    <input
      value={rascunho}
      maxLength={80}
      aria-label={`${t("Nome da etapa")} «${nome}»`}
      data-testid="nome-etapa-quadro"
      onChange={(e) => setRascunho(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelado.current = true;
          e.currentTarget.blur();
        }
      }}
      // O campo herda a cor da pílula (texto escolhido pelo contraste) e se
      // mede pelo próprio nome (`size` + `field-sizing`), para a pílula
      // abraçar o título em vez de esticar.
      size={Math.max(rascunho.length, 3)}
      className="min-w-0 max-w-full truncate rounded-sm bg-transparent px-0.5 text-[inherit] font-semibold text-inherit outline-hidden [field-sizing:content] hover:bg-black/10 focus:bg-black/10"
    />
  );
}
