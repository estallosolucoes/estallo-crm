"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useFollowupFlow, type FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

import { ExecucoesDoFluxo } from "./ExecucoesDoFluxo";

/**
 * @xyflow/react is a large dependency — this is the ONLY route that loads it.
 * `ssr:false` + dynamic import keeps it out of the main bundle entirely; see
 * the bundle delta note in the task report.
 */
const FlowCanvas = dynamic(() => import("./FlowCanvas").then((m) => m.FlowCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[600px] items-center justify-center p-6">
      <Skeleton className="h-full w-full" />
    </div>
  ),
});

interface Props {
  flowId: string;
  initialData: FollowupFlowDetailRow;
}

type Painel = "editor" | "execucoes";

/**
 * O editor e o histórico de execuções do MESMO fluxo, na mesma tela.
 *
 * O painel, a execução aberta e o bloco inspecionado moram na URL (`?painel=execucoes&exec=…&no=…`): recarregar ou
 * compartilhar o link preserva o que a pessoa estava olhando. O editor NÃO desmonta ao trocar de painel — só se
 * esconde —, porque desmontá-lo jogaria fora uma edição ainda não salva.
 */
export function FlowBuilder({ flowId, initialData }: Props) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Mesmo cache do editor: publicar uma versão nova atualiza o filtro de versões do histórico sem recarregar.
  const fluxo = useFollowupFlow(flowId, { initialData });
  const painel: Painel = params.get("painel") === "execucoes" ? "execucoes" : "editor";
  const execucaoId = params.get("exec");
  const noId = params.get("no");

  const navegar = useCallback(
    (mudancas: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(mudancas)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const aba = (qual: Painel, rotulo: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={painel === qual}
      data-testid={`painel-${qual}`}
      onClick={() => navegar(qual === "editor" ? { painel: null, exec: null, no: null } : { painel: "execucoes" })}
      className={cn(
        "border-b-2 px-3 py-2 text-sm",
        painel === qual ? "border-accent font-medium text-text" : "border-transparent text-text-muted hover:text-text",
      )}
    >
      {rotulo}
    </button>
  );

  return (
    <div className="flex h-full min-h-[600px] flex-1 flex-col" data-testid="flow-builder-shell">
      <div role="tablist" aria-label={t("Editor ou execuções do fluxo")} className="flex shrink-0 gap-1 border-b border-border px-3">
        {aba("editor", t("Editor"))}
        {aba("execucoes", t("Execuções"))}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", painel !== "editor" && "hidden")} data-testid="painel-editor-conteudo">
        <FlowCanvas flowId={flowId} initialData={initialData} />
      </div>
      {painel === "execucoes" && (
        <ExecucoesDoFluxo
          flowId={flowId}
          versoes={fluxo.data?.versions}
          execucaoId={execucaoId}
          noId={noId}
          onSelecionarExecucao={(id) => navegar({ exec: id, no: null })}
          onSelecionarNo={(id) => navegar({ no: id })}
          onVoltarAoEditor={() => navegar({ painel: null, exec: null, no: null })}
        />
      )}
    </div>
  );
}
