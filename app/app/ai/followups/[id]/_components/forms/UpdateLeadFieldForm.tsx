"use client";

import { useRef } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCamposPersonalizados } from "@/hooks/campos/useCamposPersonalizados";
import { useT } from "@/hooks/i18n/useT";

import { InserirVariavel } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

/**
 * Atualizar campo do negócio (Fase 5): o campo vem do CATÁLOGO da organização (nunca digitado), e o valor aceita
 * variáveis dos blocos anteriores. A conversão é pelo tipo do campo, na execução.
 */
export function UpdateLeadFieldForm({
  config,
  onChange,
}: {
  config: ConfigOf<"update_lead_field">;
  onChange: (c: ConfigOf<"update_lead_field">) => void;
}) {
  const t = useT();
  const campo = useRef<HTMLInputElement>(null);
  const doContato = config.alvo === "contact_field";
  const { data } = useCamposPersonalizados(doContato ? "contact" : "lead", config.alvo !== "deal_value");
  const definicoes = data?.definicoes ?? [];
  return (
    <div className="space-y-2">
      <Label htmlFor="update-field-alvo">{t("O que gravar")}</Label>
      <Select
        value={config.alvo}
        onValueChange={(v) =>
          onChange({
            ...config,
            alvo: v === "deal_value" ? "deal_value" : v === "contact_field" ? "contact_field" : "custom_field",
            // a chave é de um catálogo (negócio OU contato): trocar o alvo recomeça a escolha
            chave: "",
          })
        }
      >
        <SelectTrigger id="update-field-alvo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="custom_field">{t("Campo personalizado")}</SelectItem>
          <SelectItem value="deal_value">{t("Valor do negócio")}</SelectItem>
          <SelectItem value="contact_field">{t("Campo do contato")}</SelectItem>
        </SelectContent>
      </Select>
      {config.alvo !== "deal_value" && (
        <>
          <Label htmlFor="update-field-chave">{doContato ? t("Campo do contato") : t("Campo do negócio")}</Label>
          <Select value={config.chave || undefined} onValueChange={(v) => onChange({ ...config, chave: v })}>
            <SelectTrigger id="update-field-chave" aria-invalid={!config.chave}>
              <SelectValue placeholder={t("Escolha um campo")} />
            </SelectTrigger>
            <SelectContent>
              {definicoes.map((d) => (
                <SelectItem key={d.key} value={d.key}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="update-field-valor">{t("Valor a gravar")}</Label>
        <InserirVariavel
          soBlocos
          onInserir={(marca) => {
            const el = campo.current;
            const ini = el?.selectionStart ?? config.valor.length;
            const fim = el?.selectionEnd ?? config.valor.length;
            onChange({ ...config, valor: config.valor.slice(0, ini) + marca + config.valor.slice(fim) });
          }}
        />
      </div>
      <Input
        id="update-field-valor"
        ref={campo}
        value={config.valor}
        maxLength={2000}
        aria-invalid={!config.valor.trim()}
        onChange={(e) => onChange({ ...config, valor: e.target.value })}
      />
      <p className="text-xs text-text-muted">
        {t("Convertido pelo tipo do campo. Opção que não existe, data ou número inválidos fazem a execução falhar com a explicação.")}
      </p>
    </div>
  );
}
