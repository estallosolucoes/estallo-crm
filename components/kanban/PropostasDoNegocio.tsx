// components/kanban/PropostasDoNegocio.tsx
"use client";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { usePropostasDoLead } from "@/hooks/kanban/usePropostasDoLead";
import { formatCents } from "@/lib/money";
import { CaretRight } from "@/lib/ui/icons";

const ROTULO_DE_STATUS: Record<string, string> = {
  rascunho: "Rascunho", enviando: "Enviando", enviada: "Enviada", aceita: "Aceita",
  recusada: "Recusada", vencida: "Vencida", cancelada: "Cancelada", substituida: "Substituída",
};

interface Props {
  leadId: string;
  pipelineId: string;
  /** N1 — o atalho "Nova proposta" é `manager`+; o dossiê já sabe o papel de quem está vendo. */
  podeCriar?: boolean;
}

/**
 * N1 — seção "Propostas" do dossiê, depois de "Dados do negócio".
 *
 * Erro de leitura (inclusive o 404 de capacidade desligada, `sePropostasDesligadas`):
 * a seção some em vez de quebrar o dossiê — a página dedicada de Propostas é
 * quem mostra erro, aqui é só um resumo agregado.
 */
export function PropostasDoNegocio({ leadId, podeCriar = false }: Props): React.ReactElement | null {
  const t = useT();
  const { data: propostas, isLoading, isError } = usePropostasDoLead(leadId);

  if (isError) return null;

  return (
    <div className="shrink-0 overflow-hidden rounded-[14px] border border-border bg-card shadow-xs">
      <h3 className="flex min-h-[34px] items-center border-b border-border bg-muted/40 px-3 py-2 font-sans text-xs font-semibold text-text">{t("Propostas")}</h3>
      <div className="p-3">
      {isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}
      {!isLoading && (propostas?.length ?? 0) === 0 && (
        <p className="text-xs text-text-muted">{t("Nenhuma proposta ainda")}</p>
      )}
      {!isLoading && propostas && propostas.length > 0 && (
        <ul className="space-y-1">
          {propostas.map((p) => (
            <li key={p.id}>
              <Link href={`/app/proposals/${p.id}`} className="flex items-center gap-2 py-1.5 text-xs leading-5 hover:underline">
                <span>
                  {p.numero ? `${String(p.numero).padStart(4, "0")}/${p.ano}` : t("Rascunho")}
                  {p.versao > 1 ? ` — v${p.versao}` : ""} · {t(ROTULO_DE_STATUS[p.status] ?? p.status)}
                </span>
                <span className="ml-auto whitespace-nowrap tabular-nums">{formatCents(p.total_cents, p.moeda)}</span>
                <CaretRight size={14} className="shrink-0 text-text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {podeCriar && (
        <Link
          href={`/app/proposals/novo?lead_id=${leadId}`}
          className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
        >
          {t("Nova proposta")}
        </Link>
      )}
      </div>
    </div>
  );
}
