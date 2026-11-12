"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { DownloadSimple } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/** Nome de arquivo seguro: sem acento nem caractere que o sistema de arquivos recuse. */
function nomeDoArquivo(nome: string, origem: string): string {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${base || "automacao"}-${origem}.estallo.json`;
}

/**
 * Exportar (Fase 7): o rascunho salvo ou a versão no ar, num arquivo JSON do formato nativo do Estallo. O arquivo diz
 * de qual dos dois veio. Segredo numa configuração faz a exportação recusar com a explicação (vem da API).
 */
export function ExportFollowupFlowButton({
  flowId,
  nome,
  temPublicada,
}: {
  flowId: string;
  nome: string;
  temPublicada: boolean;
}) {
  const t = useT();
  const baixar = async (origem: "rascunho" | "publicado") => {
    try {
      const res = await apiClient.get<{ data: unknown }>(`/api/v1/ai/followup-flows/${flowId}/export?origem=${origem}`);
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nomeDoArquivo(nome, origem);
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("Automação exportada."));
    } catch (err) {
      showApiError(err);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="exportar-fluxo">
          <DownloadSimple size={14} aria-hidden className="mr-1" />
          {t("Exportar")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void baixar("rascunho")} data-testid="exportar-rascunho">
          {t("Rascunho salvo")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!temPublicada} onSelect={() => void baixar("publicado")} data-testid="exportar-publicado">
          {t("Versão no ar")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
