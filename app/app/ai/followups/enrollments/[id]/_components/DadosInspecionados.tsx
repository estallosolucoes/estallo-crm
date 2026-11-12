"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  ROTULO_DO_TIPO,
  filtrarLinhas,
  jsonParaCopiar,
  linhasDoValor,
  tipoDoValor,
} from "@/lib/followup/dados-para-inspecao";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

type Visao = "arvore" | "tabela" | "json";

/**
 * Um valor de bloco (entrada, configuração ou saída) em três visões do MESMO conteúdo — árvore, tabela e JSON — com
 * busca e cópia. `origem` diz de onde o valor vem: «Valor desta execução» (registrado) ou «Configuração do bloco».
 * Ausência, nulo, texto vazio e lista vazia aparecem com nome próprio (ver `dados-para-inspecao.ts`).
 */
export function DadosInspecionados({
  valor,
  origem,
}: {
  valor: unknown;
  /** `exemplo`: amostra simulada do editor, nunca de execução. */
  origem: "execucao" | "configuracao" | "exemplo";
}) {
  const t = useT();
  const [visao, setVisao] = useState<Visao>("arvore");
  const [busca, setBusca] = useState("");
  const [copiado, setCopiado] = useState(false);
  const { linhas, cortado } = useMemo(() => linhasDoValor(valor), [valor]);
  const visiveis = useMemo(() => filtrarLinhas(linhas, busca), [linhas, busca]);
  const tipoRaiz = tipoDoValor(valor);

  const copiar = async () => {
    // Helper do projeto: funciona também fora de contexto seguro. Se falhar, o JSON segue visível para copiar à mão.
    if (await copyToClipboard(jsonParaCopiar(valor))) {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    }
  };

  return (
    <div className="flex flex-col gap-1" data-testid="dados-inspecionados" data-origem={origem}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={origem === "execucao" ? "success" : origem === "exemplo" ? "warning" : "neutral"}>
          {origem === "execucao"
            ? t("Valor desta execução")
            : origem === "exemplo"
              ? t("Exemplo simulado")
              : t("Configuração do bloco")}
        </Badge>
        {tipoRaiz === "ausente" || tipoRaiz === "nulo" ? (
          <span className="text-[11px] text-text-muted" data-testid="dados-tipo-raiz">
            {t(ROTULO_DO_TIPO[tipoRaiz])}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={t("Forma de ver os dados")}>
          {(["arvore", "tabela", "json"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={visao === v}
              data-testid={`dados-visao-${v}`}
              onClick={() => setVisao(v)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px]",
                visao === v ? "border-accent text-accent" : "border-border text-text-muted",
              )}
            >
              {v === "arvore" ? t("Árvore") : v === "tabela" ? t("Tabela") : "JSON"}
            </button>
          ))}
          <button
            type="button"
            onClick={copiar}
            data-testid="dados-copiar"
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted"
          >
            {copiado ? t("Copiado") : t("Copiar")}
          </button>
        </div>
      </div>

      {visao !== "json" && linhas.length > 1 && (
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar campo ou valor")}
          aria-label={t("Buscar campo ou valor")}
          className="h-7 rounded-sm border border-border bg-surface px-2 text-xs"
          data-testid="dados-busca"
        />
      )}

      {visao === "json" ? (
        <pre className="max-h-56 overflow-auto rounded-sm bg-surface-muted p-2 text-[11px] leading-4" data-testid="dados-json">
          {jsonParaCopiar(valor)}
        </pre>
      ) : visao === "arvore" ? (
        <ul className="max-h-56 overflow-auto rounded-sm bg-surface-muted p-2 font-mono text-[11px] leading-5" data-testid="dados-arvore">
          {visiveis.map((l) => (
            <li key={l.caminho || "raiz"} style={{ paddingLeft: `${l.nivel * 12}px` }} data-tipo={l.tipo}>
              <span className="text-text-muted">{l.caminho.split(/[.[]/).pop()?.replace("]", "") || t("valor")}</span>
              {": "}
              <span className={cn(l.tipo === "texto_vazio" || l.tipo === "nulo" || l.tipo === "ausente" ? "italic text-warning-fg" : "")}>
                {l.valor}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="max-h-56 overflow-auto rounded-sm bg-surface-muted" data-testid="dados-tabela">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="p-1 font-medium">{t("Campo")}</th>
                <th className="p-1 font-medium">{t("Tipo")}</th>
                <th className="p-1 font-medium">{t("Valor")}</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.caminho || "raiz"} className="border-t border-border">
                  <td className="p-1 font-mono">{l.caminho || t("valor")}</td>
                  <td className="p-1">{t(ROTULO_DO_TIPO[l.tipo])}</td>
                  <td className="p-1 font-mono">{l.valor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cortado && (
        <p className="text-[11px] text-text-muted" data-testid="dados-cortado">
          {t("Mostrando só as primeiras 500 linhas; o JSON tem tudo.")}
        </p>
      )}
    </div>
  );
}
