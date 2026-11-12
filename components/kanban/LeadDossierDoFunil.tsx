"use client";
import { useMemo } from "react";
import { useQuadroDoLead } from "@/hooks/kanban/useBoard";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { CLASSE_DA_GAVETA_DO_LEAD, LeadDossier } from "./LeadDossier";

/**
 * O MESMO dossiê do quadro, aberto fora dele (ex.: Leads recentes do inbox).
 *
 * Lê o quadro do funil RECORTADO no lead (`useQuadroDoLead`, a rota do quadro
 * com `?lead_id=`): o dossiê precisa do `Lead` completo e enriquecido, das
 * etapas e dos campos, e o quadro entrega os três. Antes baixava o funil
 * INTEIRO (1.000+ negócios) para mostrar um, e só depois as seções do dossiê
 * começavam a buscar — a espera vinha em cascata.
 *
 * A gaveta abre NA HORA do clique, com o título que o card já tinha: num funil
 * grande o quadro leva segundos, e esperá-lo sem nada na tela parecia clique
 * perdido. O conteúdo entra na MESMA gaveta quando os dados chegam.
 */
export function LeadDossierDoFunil({
  pipelineId,
  leadId,
  titulo,
  onClose,
}: {
  pipelineId: string;
  leadId: string;
  /** O título já conhecido por quem abriu — mostrado enquanto o quadro carrega. */
  titulo?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { data, isError, refetch, isFetching } = useQuadroDoLead(pipelineId, leadId);
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );
  const lead = data?.leads.find((l) => l.id === leadId);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className={CLASSE_DA_GAVETA_DO_LEAD}>
        {data && lead ? (
          <LeadDossier
            embutido
            open
            onOpenChange={(v) => !v && onClose()}
            lead={lead}
            pipelineId={pipelineId}
            fieldDefs={camposDoFunil(data.pipeline.settings ?? null)}
            stageName={data.stages.find((s) => s.id === lead.stage_id)?.name ?? "—"}
            ownerNames={ownerNames}
            stages={data.stages}
          />
        ) : isError || (data && !lead) ? (
          <div role="alert" data-testid="dossie-erro" className="flex flex-col gap-3">
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base leading-6 font-semibold tracking-[-0.3px]">
                {titulo ?? t("Lead")}
              </SheetTitle>
              <SheetDescription>
                {data && !lead ? t("Lead não encontrado.") : t("Não foi possível carregar o lead.")}
              </SheetDescription>
            </SheetHeader>
            {isError && (
              <Button variant="outline" size="sm" className="self-start" disabled={isFetching} onClick={() => void refetch()}>
                {t("Tentar de novo")}
              </Button>
            )}
          </div>
        ) : (
          <div aria-busy="true" data-testid="dossie-carregando" className="flex flex-col gap-3">
            <SheetHeader className="pr-8">
              <SheetTitle className="text-base leading-6 font-semibold tracking-[-0.3px]">
                {titulo ?? t("Carregando…")}
              </SheetTitle>
              <SheetDescription className="sr-only">{t("Carregando…")}</SheetDescription>
            </SheetHeader>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
