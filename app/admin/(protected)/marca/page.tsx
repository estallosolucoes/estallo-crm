import { notFound } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import { marcaDaPlataforma } from "@/lib/branding/plataforma";
import { LogotipoDoProduto } from "@/components/branding/MarcaDoProduto";
import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Identidade da plataforma" };
export default async function Page() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin || user.support) notFound();
  const marca = marcaDaPlataforma();
  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="space-y-6 p-4 md:p-6">
      <h1 className="text-2xl font-semibold">Identidade da plataforma</h1>
      <Card className="max-w-2xl space-y-5 p-6">
        <LogotipoDoProduto nome={marca.name} className="h-12 w-auto" />
        <p className="text-sm text-text-muted">
          {t(
            "A identidade é definida pelo Design System da plataforma e acompanha todas as contas. Alterações são publicadas pela equipe Estallo, junto com o aplicativo.",
          )}
        </p>
        <p className="text-sm text-text-muted">
          {t("Configurações de white-label herdadas não alteram a identidade desta versão.")}
        </p>
      </Card>
    </div>
  );
}
