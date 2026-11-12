"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface RetomarComoNovoNegocioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  /** A etapa ABERTA para onde o negócio encerrado foi levado. */
  stageId: string;
  pipelineId: string;
  /** "Mover este negócio": reabre o MESMO registro na etapa (o move de sempre). */
  onMoverEste: () => void;
}

/**
 * Um negócio GANHO ou PERDIDO levado para uma etapa aberta — no funil (arrasto)
 * ou no dossiê (trilho de etapas, também dentro da inbox). Desde 30/10/2026 a
 * escolha é de quem move, não do funil:
 *
 *  - "Criar novo negócio" chama `POST /api/v1/leads/{id}/retomar`: nova
 *    tentativa com o mesmo contato (campos e tags conforme
 *    `settings.reabertura_campos`), `source = "retomada"` e
 *    `retomado_de_lead_id` para o original — que NÃO é tocado.
 *  - "Mover este negócio" reabre o mesmo registro na etapa
 *    (`fn_crm_lead_close_on_stage` limpa status e data de fechamento).
 */
export function RetomarComoNovoNegocioDialog({
  open,
  onOpenChange,
  leadId,
  stageId,
  pipelineId,
  onMoverEste,
}: RetomarComoNovoNegocioDialogProps) {
  const t = useT();
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);

  const criarNovo = async () => {
    if (criando) return;
    setCriando(true);
    try {
      await apiClient.post(`/api/v1/leads/${leadId}/retomar`, { stage_id: stageId });
      await qc.invalidateQueries({ queryKey: ["board", pipelineId] });
      onOpenChange(false);
    } catch (erro) {
      if (erro instanceof ApiError) showApiError(erro);
      else throw erro;
    } finally {
      setCriando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Este lead já foi encerrado")}</DialogTitle>
          <DialogDescription>
            {t(
              "Criar um novo lead mantém este como está (ganho ou perdido) e abre um novo lead com o mesmo contato, copiando campos e tags. Mover o lead existente o reabre na etapa escolhida.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={criando}>
            {t("Cancelar")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              onMoverEste();
            }}
            disabled={criando}
          >
            {t("Mover lead existente")}
          </Button>
          <Button onClick={() => void criarNovo()} disabled={criando}>
            {criando ? t("Criando…") : t("Criar novo lead")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
