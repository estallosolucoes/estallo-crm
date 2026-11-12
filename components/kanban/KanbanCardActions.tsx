"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { DotsThree, PencilSimple, Users } from "@/lib/ui/icons";
import { useWinLead, useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { usePropostaEnviadaDoLead } from "@/hooks/kanban/usePropostaEnviadaDoLead";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { MoveToOtherPipelineDialog } from "./MoveToOtherPipelineDialog";
import { EditLeadDialog } from "./EditLeadDialog";
import type { Lead } from "@/lib/types/leads";

interface KanbanCardActionsProps {
  lead: Lead;
  pipelineId: string;
}

// O menu permanece visível em mouse, toque e teclado.
const CLASSE_DO_GATILHO = "h-8 w-8 shrink-0 opacity-100";

/**
 * O "⋯" do card. Até o primeiro uso é SÓ o botão: o menu completo traz 4
 * consultas, 6 mutações, um formulário e 4 diálogos, e montá-los em cada um
 * dos ~1.100 cards de um funil grande travava o scroll e o clique do quadro.
 * No primeiro toque o menu monta já aberto — e fica montado depois disso.
 */
export function KanbanCardActions(props: KanbanCardActionsProps) {
  const t = useT();
  const [montado, setMontado] = useState(false);
  if (montado) return <AcoesDoCard {...props} />;
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon"
        className={CLASSE_DO_GATILHO}
        aria-label={t("Ações do lead")}
        aria-haspopup="menu"
        // O Radix abre no `pointerdown`; aqui é o mesmo gesto que monta o menu.
        onPointerDown={(e) => {
          if (e.button !== 0 || e.ctrlKey) return;
          e.preventDefault();
          setMontado(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            setMontado(true);
          }
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <DotsThree size={16} weight="bold" className="rotate-90" />
      </Button>
    </span>
  );
}

function AcoesDoCard({ lead, pipelineId }: KanbanCardActionsProps) {
  const t = useT();
  const [loseOpen, setLoseOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const winMutation = useWinLead(pipelineId);
  const editMutation = useEditLead(pipelineId);
  // Excluir um card é a mesma ação da barra de seleção, com um id só: mesma
  // rota, mesmo gate de papel, mesmo evento e auditoria.
  const bulk = useBulkAction(pipelineId);
  // D10: só consulta quando o diálogo de excluir abre — não é gasto em toda
  // renderização do card.
  const { data: propostaEnviada } = usePropostaEnviadaDoLead(lead.id, deleteOpen);
  // spec 13 §4: escrita no funil é agent+ — viewer não reatribui (a rota
  // PATCH também recusa; aqui é só não oferecer o que seria negado).
  const canAssign = usePermission("pipeline.move_card");
  const { data: members } = useAssignableMembers(canAssign);
  // A rota já devolve só agente ativo e não arquivado — é o picker.
  const { data: agents } = useAssignableAgents(canAssign);

  const reassignToUser = (ownerUserId: string | null) => {
    if (ownerUserId === lead.owner_user_id) return;
    editMutation.mutate({ leadId: lead.id, patch: { owner_user_id: ownerUserId } });
  };

  /** Transferir para um agente: o handler zera o dono humano e deriva owner_kind. */
  const reassignToAgent = (agentId: string) => {
    if (agentId === lead.owner_agent_id) return;
    editMutation.mutate({ leadId: lead.id, patch: { owner_agent_id: agentId } });
  };

  const clearOwner = () => {
    if (lead.owner_user_id === null && lead.owner_agent_id === null) return;
    editMutation.mutate({
      leadId: lead.id,
      patch: lead.owner_agent_id ? { owner_agent_id: null } : { owner_user_id: null },
    });
  };

  return (
    /*
      A BARREIRA DE CLIQUE DO CARD — `display: contents`, não uma caixa.
      O card inteiro tem `onClick={handleClick}`
      (`components/kanban/KanbanCard.tsx`), e `decidirClique` NÃO inspeciona o
      alvo: qualquer clique que suba até lá abre o dossiê do lead. Os três
      diálogos daqui e o menu são renderizados em PORTAL, e portal do React
      propaga evento pela ÁRVORE REACT — ou seja, pelo card. Medido em jsdom
      antes desta linha: clicar no overlay da confirmação de excluir — o gesto
      padrão de desistir — abria o dossiê ATRÁS de uma janela que nem fecha (o
      `AlertDialog` não fecha por clique fora, de propósito).
      `display: contents` não cria caixa: o layout do card não muda, e a árvore
      React passa a interceptar os cliques de todo overlay portado daqui.
      Vigiado por `tests/unit/kanban-card-excluir.test.tsx`, com o controle
      positivo de que clicar no CARD continua abrindo o dossiê.
    */
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      {/* Só monta quando alguém já pediu o menu: nasce aberto. */}
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={CLASSE_DO_GATILHO}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("Ações do lead")}
          >
            <DotsThree size={16} weight="bold" className="rotate-90" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onSelect={() => {
              setEditOpen(true);
            }}
          >
            <PencilSimple size={14} className="mr-2" /> {t("Editar")}
          </DropdownMenuItem>
          {canAssign && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Users size={14} className="mr-2" /> {t("Responsável")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  disabled={
                    editMutation.isPending ||
                    (lead.owner_user_id === null && lead.owner_agent_id === null)
                  }
                  onSelect={clearOwner}
                >
                  {t("Sem responsável")}
                </DropdownMenuItem>
                {(members ?? []).length > 0 && <DropdownMenuSeparator />}
                {(members ?? []).map((m) => (
                  <DropdownMenuItem
                    key={m.user_id}
                    disabled={editMutation.isPending || m.user_id === lead.owner_user_id}
                    onSelect={() => reassignToUser(m.user_id)}
                  >
                    {m.full_name ?? t("Sem nome")}
                  </DropdownMenuItem>
                ))}
                {(agents ?? []).length > 0 && <DropdownMenuSeparator />}
                {(agents ?? []).map((a) => (
                  <DropdownMenuItem
                    key={a.agent_id}
                    disabled={editMutation.isPending || a.agent_id === lead.owner_agent_id}
                    onSelect={() => reassignToAgent(a.agent_id)}
                  >
                    {a.name}
                    {a.version_number != null && (
                      <span className="ml-1.5 font-mono text-[10px] text-text-muted">
                        v{a.version_number}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            disabled={winMutation.isPending}
            onSelect={() => {
              winMutation.mutate({ leadId: lead.id });
            }}
          >
            {t("Marcar como ganho")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setLoseOpen(true);
            }}
          >
            {t("Marcar como perdido")}
          </DropdownMenuItem>
          {/*
            `canAssign` já É `usePermission("pipeline.move_card")` — a MESMA
            permissão que `POST /api/v1/leads/[id]/move-pipeline` exige no servidor
            (`requireRole("agent")`). Mostrar o item a quem o servidor
            recusaria seria prometer o que não se cumpre.
          */}
          {canAssign && (
            <DropdownMenuItem
              onSelect={() => {
                setMoveOpen(true);
              }}
            >
              {t("Mover de funil")}
            </DropdownMenuItem>
          )}
          {canAssign && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-error-fg"
                disabled={bulk.isPending}
                onSelect={() => {
                  setDeleteOpen(true);
                }}
              >
                {t("Excluir")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        `AlertDialog`, e não `Dialog`: é o padrão que
        `docs/doctrine/destrutivo-pede-confirmacao.md` (§Como aplicar) fixa para
        o clique que apaga trabalho, o mesmo de `DeleteFollowupFlowButton`. A
        diferença não é cosmética — o `Dialog` comum fecha ao clicar fora, e
        fechar por engano é justamente o gesto que a confirmação existe para
        impedir.
      */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{`${t("Excluir")} "${lead.title}"?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "O card sai do funil com o histórico de atividades. O contato e as conversas continuam. Esta ação não pode ser desfeita.",
              )}
              {propostaEnviada && (
                <>
                  {" "}
                  {t("O negócio some; a proposta")}{" "}
                  {String(propostaEnviada.numero).padStart(4, "0")}/{propostaEnviada.ano}{" "}
                  {t("continua em Propostas")}.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            {/*
              `preventDefault` porque o `AlertDialogAction` fecha o diálogo no
              próprio clique: sem ele a janela sumiria ANTES de o servidor
              responder, e um erro chegaria sobre uma tela que já diz "pronto".
              Quem fecha é o `onSuccess`; quem impede o envio em dobro enquanto
              isso é o `disabled`.
            */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={bulk.isPending}
              onClick={(e) => {
                e.preventDefault();
                bulk.mutate(
                  { action: "delete", lead_ids: [lead.id], params: {} },
                  { onSuccess: () => setDeleteOpen(false) },
                );
              }}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LoseLeadDialog
        open={loseOpen}
        onOpenChange={setLoseOpen}
        leadId={lead.id}
        pipelineId={pipelineId}
      />
      <MoveToOtherPipelineDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        leadId={lead.id}
        pipelineId={pipelineId}
        expectedUpdatedAt={lead.updated_at}
      />
      <EditLeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead}
        pipelineId={pipelineId}
      />
    </span>
  );
}
