"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { MAXIMO_DE_FUNIS_FIXADOS, useFunisFixados } from "@/hooks/kanban/useFunisFixados";
import { PushPin } from "@/lib/ui/icons";

/** Fixa (ou solta) o funil no menu lateral — até 3 (`useFunisFixados`). */
export function BotaoFixarFunil({ id, nome }: { id: string; nome: string }) {
  const t = useT();
  const { fixados, alternar } = useFunisFixados();
  const fixado = fixados.some((f) => f.id === id);
  const rotulo = fixado ? t("Desafixar do menu") : t("Fixar no menu");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={fixado}
      aria-label={`${rotulo}: ${nome}`}
      title={rotulo}
      data-testid={`fixar-funil-${id}`}
      onClick={() => {
        if (!alternar({ id, nome })) {
          toast.error(
            t("Você já fixou {n} funis. Desafixe um para fixar este.").replace(
              "{n}",
              String(MAXIMO_DE_FUNIS_FIXADOS),
            ),
          );
        }
      }}
    >
      <PushPin size={16} weight={fixado ? "fill" : "regular"} className="mr-1" aria-hidden />
      {rotulo}
    </Button>
  );
}
