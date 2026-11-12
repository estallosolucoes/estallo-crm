"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
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
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ROLE_RANK } from "@/lib/auth/types";
import { CaretDown, EnvelopeSimple, Eraser, PushPin, PushPinSlash, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

type Confirmacao = "limpar" | "apagar" | null;

/**
 * A SETINHA DE CADA CONVERSA e o menu dela (16/10/2026): Fixar/Desafixar,
 * Marcar como não lida, Limpar conversa e Apagar conversa — o desenho de
 * `previews/inbox-menu` do dono.
 *
 * Fixar é de QUEM USA (0662). Limpar e apagar são `manager`+ e pedem
 * confirmação: apagam mensagens de vez — só no CRM, nunca no WhatsApp do
 * cliente, e a confirmação diz isso. As rotas moram em
 * `app/api/v1/conversations/[id]/{pin,mark-unread,clear}` e no DELETE da conversa.
 */
export function AcoesDaConversa({
  conversationId,
  nome,
  fixada,
  aberta,
  onFecharConversa,
}: {
  conversationId: string;
  nome: string;
  fixada: boolean;
  /** A conversa está aberta no chat agora. */
  aberta: boolean;
  /** Fecha a conversa aberta (marcar como não lida; apagar). */
  onFecharConversa?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { user, activeOrg } = useAuth();
  const [confirmacao, setConfirmacao] = useState<Confirmacao>(null);
  const [ocupado, setOcupado] = useState(false);
  const somenteLeitura = user.support?.access_mode === "support_readonly";
  const podeApagar =
    !somenteLeitura &&
    ((user.is_platform_admin && !user.support) ||
      (activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager));

  const atualizar = () => {
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
  };

  async function executar(acao: () => Promise<unknown>, sucesso: string, depois?: () => void) {
    setOcupado(true);
    try {
      await acao();
      toast.success(sucesso);
      depois?.();
      atualizar();
    } catch (erro) {
      showApiError(erro);
    } finally {
      setOcupado(false);
    }
  }

  const base = `/api/v1/conversations/${conversationId}`;

  return (
    // A linha inteira é um botão de abrir a conversa: o clique no menu (e nos
    // diálogos, que são portais da árvore React) não pode subir até ele.
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ibx-row-menu"
            aria-label={`${t("Ações da conversa")}: ${nome}`}
            title={t("Ações da conversa")}
            data-testid={`acoes-da-conversa-${conversationId}`}
            disabled={ocupado || somenteLeitura}
          >
            <CaretDown size={14} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="ibx ibx-floating ibx-menu">
          {fixada ? (
            <DropdownMenuItem
              className="ibx-menu-item"
              onSelect={() =>
                void executar(() => apiClient.delete(`${base}/pin`), t("Conversa desafixada"))
              }
            >
              <PushPinSlash className="ibx-icon" aria-hidden />
              {t("Desafixar conversa")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className="ibx-menu-item"
              onSelect={() =>
                void executar(() => apiClient.post(`${base}/pin`, {}), t("Conversa fixada no topo"))
              }
            >
              <PushPin className="ibx-icon" aria-hidden />
              {t("Fixar conversa")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="ibx-menu-item"
            onSelect={() =>
              void executar(
                () => apiClient.post(`${base}/mark-unread`, {}),
                t("Marcada como não lida"),
                // Aberta, a leitura automática (`useMarkAsRead`) zeraria o
                // contador de novo em 1,5 s — a conversa fecha, como no WhatsApp.
                aberta ? onFecharConversa : undefined,
              )
            }
          >
            <EnvelopeSimple className="ibx-icon" aria-hidden />
            {t("Marcar como não lida")}
          </DropdownMenuItem>
          {podeApagar && (
            <>
              <div className="ibx-menu-separator" role="separator" />
              <DropdownMenuItem className="ibx-menu-item" onSelect={() => setConfirmacao("limpar")}>
                <Eraser className="ibx-icon" aria-hidden />
                {t("Limpar conversa")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="ibx-menu-item ibx-danger"
                onSelect={() => setConfirmacao("apagar")}
              >
                <Trash className="ibx-icon" aria-hidden />
                {t("Apagar conversa")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmacao !== null} onOpenChange={(v) => !v && setConfirmacao(null)}>
        <AlertDialogContent data-testid="confirmar-acao-da-conversa">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmacao === "apagar" ? t("Apagar esta conversa?") : t("Limpar esta conversa?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmacao === "apagar"
                ? t(
                    "A conversa e todas as mensagens dela saem do CRM. O WhatsApp do cliente não muda. Esta ação não pode ser desfeita.",
                  )
                : t(
                    "Todas as mensagens desta conversa saem do CRM; a conversa, o responsável e as etiquetas ficam. O WhatsApp do cliente não muda. Esta ação não pode ser desfeita.",
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }))}
              disabled={ocupado}
              onClick={() => {
                const qual = confirmacao;
                setConfirmacao(null);
                if (qual === "apagar") {
                  void executar(
                    () => apiClient.delete(base),
                    t("Conversa apagada"),
                    aberta ? onFecharConversa : undefined,
                  );
                } else {
                  void executar(() => apiClient.post(`${base}/clear`, {}), t("Conversa limpa"), () => {
                    void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
                  });
                }
              }}
            >
              {confirmacao === "apagar" ? t("Apagar conversa") : t("Limpar conversa")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
