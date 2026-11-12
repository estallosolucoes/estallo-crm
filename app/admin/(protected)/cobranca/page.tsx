import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { PlanosDemonstrativos } from "@/components/plans/PlanosDemonstrativos";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Planos e assinatura" };
export default async function PlanosDaPlataformaPage() {
  await requirePlatformAdmin();
  const idioma = (await loadAuthUser())?.idioma ?? "pt-BR";
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Planos e assinatura</h1>
        <p className="mt-2 text-sm text-text-muted">
          {t(
            "Catálogo demonstrativo da plataforma. Valores finais e ativação de pagamentos ainda estão pendentes.",
          )}
        </p>
      </header>
      <PlanosDemonstrativos idioma={idioma} />
      <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
        <strong className="text-text">{t("Configuração de pagamentos pendente.")}</strong>{" "}
        {t("A contratação será habilitada após a configuração e validação da integração Stripe.")}
      </div>
    </div>
  );
}
