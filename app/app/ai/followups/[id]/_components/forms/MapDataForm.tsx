"use client";

import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { mapDataFieldSchema } from "@/lib/followup/graph-schema";
import { TIPOS_DO_CAMPO_DO_MAPA } from "@/lib/followup/vocabulario";
import { Plus, Trash } from "@/lib/ui/icons";

import { InserirVariavel } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

type Campo = ConfigOf<"map_data">["fields"][number];

const TIPOS = Object.entries(TIPOS_DO_CAMPO_DO_MAPA).map(([valor, rotulo]) => ({ valor: valor as Campo["type"], rotulo }));

/**
 * O bloco Mapear dados (Fase 4): cada linha é um campo com nome, valor (texto com variáveis dos blocos anteriores) e
 * tipo. Os blocos seguintes citam o campo pelo NOME (`{{nodes.<bloco>.fields.<nome>}}`). O valor padrão só vale
 * quando escrito: sem ele, valor ausente faz a execução falhar com explicação, em vez de seguir com vazio.
 */
export function MapDataForm({
  config,
  onChange,
}: {
  config: ConfigOf<"map_data">;
  onChange: (c: ConfigOf<"map_data">) => void;
}) {
  const t = useT();
  const valores = useRef<Array<HTMLInputElement | null>>([]);

  const trocar = (i: number, campo: Partial<Campo>) =>
    onChange({ fields: config.fields.map((f, j) => (j === i ? { ...f, ...campo } : f)) });

  return (
    <div className="space-y-3" data-testid="form-mapear-dados">
      {config.fields.length === 0 && (
        <p className="text-xs text-text-muted">{t("Nenhum campo ainda. Acrescente o primeiro.")}</p>
      )}
      {config.fields.map((f, i) => {
        const nomeOk = mapDataFieldSchema.shape.name.safeParse(f.name).success;
        return (
          <fieldset key={i} className="space-y-2 rounded-md border border-border p-2" data-testid="campo-do-mapa">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor={`mapa-nome-${i}`}>{t("Nome do campo")}</Label>
                <Input
                  id={`mapa-nome-${i}`}
                  value={f.name}
                  placeholder="valor_total"
                  aria-invalid={!nomeOk}
                  onChange={(e) => trocar(i, { name: e.target.value.trim().toLowerCase() })}
                />
              </div>
              <div className="w-28">
                <Label htmlFor={`mapa-tipo-${i}`}>{t("Tipo")}</Label>
                <Select value={f.type} onValueChange={(v) => trocar(i, { type: v as Campo["type"] })}>
                  <SelectTrigger id={`mapa-tipo-${i}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIPOS.map((tp) => (
                      <SelectItem key={tp.valor} value={tp.valor}>
                        {t(tp.rotulo)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover campo")}
                onClick={() => onChange({ fields: config.fields.filter((_, j) => j !== i) })}
              >
                <Trash size={14} />
              </Button>
            </div>
            {!nomeOk && (
              <p className="text-xs text-error-fg">{t("Use letras minúsculas, números e _ (começando por letra).")}</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`mapa-valor-${i}`}>{t("Valor")}</Label>
              <InserirVariavel
                soBlocos
                onInserir={(marca) => {
                  const campo = valores.current[i];
                  const inicio = campo?.selectionStart ?? f.value.length;
                  const fim = campo?.selectionEnd ?? f.value.length;
                  trocar(i, { value: f.value.slice(0, inicio) + marca + f.value.slice(fim) });
                }}
              />
            </div>
            <Input
              id={`mapa-valor-${i}`}
              ref={(el) => {
                valores.current[i] = el;
              }}
              value={f.value}
              placeholder={t("texto ou variável de um bloco anterior")}
              onChange={(e) => trocar(i, { value: e.target.value })}
            />
            <Label htmlFor={`mapa-padrao-${i}`}>{t("Valor padrão (opcional)")}</Label>
            <Input
              id={`mapa-padrao-${i}`}
              value={f.fallback ?? ""}
              placeholder={t("usado só quando o valor não existir")}
              onChange={(e) => trocar(i, { fallback: e.target.value || undefined })}
            />
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={config.fields.length >= 30}
        onClick={() =>
          onChange({ fields: [...config.fields, { name: `campo_${config.fields.length + 1}`, value: "", type: "text" }] })
        }
      >
        <Plus size={14} /> {t("Acrescentar campo")}
      </Button>
      <p className="text-xs text-text-muted">
        {t("Os blocos seguintes usam cada campo pelo nome, em «Inserir variável». Sem valor padrão, um valor ausente faz a execução falhar com a explicação.")}
      </p>
    </div>
  );
}
