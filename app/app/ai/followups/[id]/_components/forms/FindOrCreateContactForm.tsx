"use client";

import { useRef } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

import { InserirVariavel, inserirNoCursor } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

/** Buscar ou criar contato (Fase 5): procura por telefone ou e-mail; com «criar», cria quando não acha. */
export function FindOrCreateContactForm({
  config,
  onChange,
}: {
  config: ConfigOf<"find_or_create_contact">;
  onChange: (c: ConfigOf<"find_or_create_contact">) => void;
}) {
  const t = useT();
  const valor = useRef<HTMLInputElement>(null);
  const nome = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <Label htmlFor="foc-busca">{t("Procurar por")}</Label>
      <Select value={config.busca} onValueChange={(v) => onChange({ ...config, busca: v === "email" ? "email" : "phone" })}>
        <SelectTrigger id="foc-busca">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Literais por ramo (cerca de i18n): os rótulos são os de `BUSCAS_DO_CONTATO` (vocabulario.ts). */}
          <SelectItem value="phone">{t("Telefone")}</SelectItem>
          <SelectItem value="email">{t("E-mail")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="foc-valor">{config.busca === "email" ? t("E-mail procurado") : t("Telefone procurado")}</Label>
        <InserirVariavel
          soBlocos
          onInserir={(m) => onChange({ ...config, valor: inserirNoCursor(valor.current, config.valor, m) })}
        />
      </div>
      <Input
        id="foc-valor"
        ref={valor}
        value={config.valor}
        maxLength={500}
        aria-invalid={!config.valor.trim()}
        onChange={(e) => onChange({ ...config, valor: e.target.value })}
      />
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="foc-criar">{t("Criar o contato se não achar")}</Label>
        <Switch id="foc-criar" checked={config.criar} onCheckedChange={(criar) => onChange({ ...config, criar })} />
      </div>
      {config.criar && (
        <>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="foc-nome">{t("Nome do contato novo")}</Label>
            <InserirVariavel
              soBlocos
              onInserir={(m) => onChange({ ...config, nome: inserirNoCursor(nome.current, config.nome, m) })}
            />
          </div>
          <Input
            id="foc-nome"
            ref={nome}
            value={config.nome}
            maxLength={200}
            onChange={(e) => onChange({ ...config, nome: e.target.value })}
          />
        </>
      )}
      <p className="text-xs text-text-muted">{t("Os blocos seguintes podem agir sobre este contato pela opção «Aplicar em».")}</p>
    </div>
  );
}
