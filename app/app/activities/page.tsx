import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { ActivityReportClient } from "./_components/ActivityReportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Atividades" };

/**
 * Relatório de atividades. A aba "Por etiqueta" saiu com a 0659: ela só existia
 * sobre a etiqueta da CONVERSA, e o Estallo deixou de etiquetar conversas.
 */
export default async function ActivitiesReportPage() {
  const user = await requireAuth();
  // `t` local e não o hook: componente de SERVIDOR — o idioma já vem resolvido
  // pela cadeia pessoa → organização → padrão em `lib/auth/server.ts`.
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Atividades")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que aconteceu na operação no período — e quanto disso foi a equipe.")}
        </p>
      </header>

      <ActivityReportClient />
    </div>
  );
}
