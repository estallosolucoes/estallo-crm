"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useMoveLeadToPipeline } from "@/hooks/kanban/useUpdateLead";
import { useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";

interface MoveToOtherPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  pipelineId: string;
  /** O `updated_at` que a tela leu — a trava otimista do servidor. */
  expectedUpdatedAt: string;
  /** Depois de mover: o card saiu deste funil (o dossiê aberto deve fechar). */
  onMovido?: () => void;
}

/**
 * "Mover de funil" — o MESMO negócio vai para a etapa escolhida de outro funil
 * (`POST /api/v1/leads/[id]/move-pipeline`). Os destinos e as etapas abertas
 * de cada um vêm de `GET /api/v1/leads/[id]/clone`.
 */
export function MoveToOtherPipelineDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
  expectedUpdatedAt,
  onMovido,
}: MoveToOtherPipelineDialogProps) {
  const t = useT();
  const [funilId, setFunilId] = useState("");
  const [etapaId, setEtapaId] = useState("");
  const mutation = useMoveLeadToPipeline(pipelineId);
  const destinos = useDestinosDeFunil(leadId, open);
  const etapas = destinos.data?.find((d) => d.id === funilId)?.etapas ?? [];

  const limpar = () => {
    setFunilId("");
    setEtapaId("");
  };
  const disabled = !etapaId || mutation.isPending;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      await mutation.mutateAsync({ leadId, stageId: etapaId, expectedUpdatedAt });
      limpar();
      onOpenChange(false);
      onMovido?.();
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) limpar();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Mover de funil")}</DialogTitle>
          <DialogDescription>
            {t(
              "O negócio muda para o funil e a etapa escolhidos — conversa, tarefas, campos e histórico vão junto.",
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Instalação nova nasce com UM funil só: sem esta frase o diálogo
            abriria com uma lista vazia e um botão que nunca habilita. */}
        {destinos.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Este é o único funil. Crie outro funil para poder levar o negócio até ele.")}
          </p>
        ) : (
          <div className="space-y-3">
            <Select
              value={funilId}
              onValueChange={(v) => {
                setFunilId(v);
                // A primeira etapa aberta já vem marcada — é o destino mais comum.
                setEtapaId(destinos.data?.find((d) => d.id === v)?.etapas?.[0]?.id ?? "");
              }}
            >
              <SelectTrigger aria-label={t("Funil de destino")}>
                <SelectValue placeholder={t("Escolha o funil de destino")} />
              </SelectTrigger>
              <SelectContent>
                {(destinos.data ?? []).map((pipeline) => (
                  <SelectItem key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {funilId && (
              <Select value={etapaId} onValueChange={setEtapaId}>
                <SelectTrigger aria-label={t("Etapa de destino")}>
                  <SelectValue placeholder={t("Escolha a etapa")} />
                </SelectTrigger>
                <SelectContent>
                  {etapas.map((etapa) => (
                    <SelectItem key={etapa.id} value={etapa.id}>
                      {etapa.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {mutation.isPending ? t("Salvando...") : t("Mover")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
