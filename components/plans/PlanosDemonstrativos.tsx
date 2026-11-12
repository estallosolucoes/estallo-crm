import { PLANOS_DEMONSTRATIVOS, precoDemonstrativo } from "@/lib/planos/catalogo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { cn } from "@/lib/utils";

export function PlanosDemonstrativos({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  return (
    <div className="space-y-6">
      <div
        role="note"
        className="rounded-lg border border-border bg-accent-soft p-4 text-sm text-text"
      >
        <p className="font-semibold">{t("Planos em demonstração")}</p>
        <p className="mt-1">
          {t(
            "Os preços e limites abaixo são ilustrativos. Nenhuma cobrança será feita e esses limites ainda não são aplicados à sua conta.",
          )}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {PLANOS_DEMONSTRATIVOS.map((plano) => (
          <Card
            key={plano.id}
            className={cn(
              "relative flex flex-col gap-5 p-6",
              plano.destaque && "border-accent shadow-md",
            )}
          >
            <div>
              <p className="mb-2 text-xs font-semibold tracking-wider text-accent uppercase">
                {plano.destaque ? t("Para crescer") : t("Plano")}
              </p>
              <h2 className="text-xl font-semibold">{plano.nome}</h2>
              <p className="mt-2 min-h-10 text-sm text-text-muted">{plano.descricao}</p>
            </div>
            <p>
              <span className="text-3xl font-bold tracking-tight">
                {precoDemonstrativo(plano.preco_cents)}
              </span>
              <span className="ml-1 text-sm text-text-muted">{t("/mês")}</span>
            </p>
            <ul className="space-y-3 text-sm text-text-muted">
              <li>
                <strong className="text-text">{plano.usuarios}</strong> {t("usuários")}
              </li>
              <li>
                <strong className="text-text">{plano.canais}</strong>{" "}
                {plano.canais === 1 ? t("número conectado") : t("números conectados")}
              </li>
              <li>
                <strong className="text-text">{plano.contatos.toLocaleString("pt-BR")}</strong>{" "}
                {t("contatos")}
              </li>
              <li>{t("Atendimento, funil e agenda")}</li>
            </ul>
            <Button
              disabled
              title={t("Contratação em breve: os preços desta etapa são demonstrativos.")}
              className="mt-auto w-full"
              variant={plano.destaque ? "primary" : "secondary"}
            >
              {t("Contratação em breve")}
            </Button>
          </Card>
        ))}
      </div>
      <p className="text-sm text-text-muted">
        {t("Você poderá contratar e gerenciar seu plano por aqui quando o pagamento estiver disponível.")}
      </p>
    </div>
  );
}
