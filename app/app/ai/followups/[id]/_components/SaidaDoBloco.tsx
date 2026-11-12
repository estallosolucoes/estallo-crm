"use client";

import type { FlowNode } from "@/lib/followup/graph-schema";
import { saidaDeExemplo } from "@/lib/followup/previa-do-texto";
import { camposDeSaidaDoNo } from "@/lib/followup/variaveis-de-blocos";
import { useT } from "@/hooks/i18n/useT";

import { DadosInspecionados } from "../../enrollments/[id]/_components/DadosInspecionados";

/**
 * «O que este bloco entrega» no editor (Fase 4): o CONTRATO declarado (os campos que os blocos seguintes podem citar,
 * com a marca exata) e um EXEMPLO simulado, com rótulo próprio. O valor real só existe na aba Execuções.
 */
export function SaidaDoBloco({ no }: { no: FlowNode }) {
  const t = useT();
  const campos = camposDeSaidaDoNo(no);
  if (campos.length === 0) return null;
  return (
    <section className="space-y-2 border-t border-border pt-4" data-testid="saida-do-bloco">
      <h4 className="text-sm font-medium">{t("O que este bloco entrega")}</h4>
      <p className="text-xs text-text-muted">{t("Contrato declarado: os blocos seguintes podem usar estes campos.")}</p>
      <ul className="space-y-1" data-testid="saida-contrato">
        {campos.map((c) => (
          <li key={c.caminho} className="text-xs">
            <span className="font-medium">{t(c.rotulo)}</span>{" "}
            <code className="font-mono text-[11px] text-text-muted">{`{{nodes.${no.id}.${c.caminho}}}`}</code>
          </li>
        ))}
      </ul>
      <DadosInspecionados valor={saidaDeExemplo(no)} origem="exemplo" />
    </section>
  );
}
