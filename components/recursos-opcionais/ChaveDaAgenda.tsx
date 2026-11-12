"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A chave da Agenda, na linha dela em Configurações › Recursos opcionais (só
 * admin). Desligada, somem a tela, o item de menu e as ferramentas de
 * agendamento do agente. `router.refresh()` relê o layout, que recalcula o menu
 * e o estado da linha.
 */
export function ChaveDaAgenda({ ligada: inicial }: { ligada: boolean }) {
  const t = useT();
  const router = useRouter();
  const [ligada, setLigada] = useState(inicial);
  const [salvando, setSalvando] = useState(false);

  async function alternar(valor: boolean) {
    setSalvando(true);
    try {
      await apiClient.patch("/api/v1/settings/agenda-habilitada", { habilitada: valor });
      setLigada(valor);
      toast.success(valor ? t("Agenda ligada.") : t("Agenda desligada."));
      router.refresh();
    } catch (erro) {
      showApiError(erro);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Switch
      checked={ligada}
      disabled={salvando}
      onCheckedChange={(v) => void alternar(v)}
      aria-label={t("Agenda")}
      data-testid="recurso-agenda"
    />
  );
}
