import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { PlanosDemonstrativos } from "@/components/plans/PlanosDemonstrativos";

export const metadata = { title: "Plano e cobrança" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg || ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) redirect("/403");
  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header>
        <p className="mb-2 text-xs font-semibold tracking-wider text-accent uppercase">
          {t("Seu próximo passo")}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Plano e cobrança")}</h1>
        <p className="mt-2 text-sm text-text-muted">{t("Uma opção para cada etapa da sua operação.")}</p>
      </header>
      <PlanosDemonstrativos idioma={user.idioma} />
    </div>
  );
}
