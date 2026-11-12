"use client";

import { useRef } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { etapasPorFunil } from "@/hooks/followup/useEtapasDeGatilho";
import { useT } from "@/hooks/i18n/useT";

import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import { AlvoDoBloco, InserirVariavel, inserirNoCursor } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

/** Buscar ou criar negócio (Fase 5): o negócio ABERTO do contato no funil; com «criar», cria na etapa escolhida. */
export function FindOrCreateLeadForm({
  config,
  onChange,
}: {
  config: ConfigOf<"find_or_create_lead">;
  onChange: (c: ConfigOf<"find_or_create_lead">) => void;
}) {
  const t = useT();
  const titulo = useRef<HTMLInputElement>(null);
  const { etapas } = useEtapasDoFluxo();
  const funis = etapasPorFunil(etapas);
  const funil = funis.find((f) => f.id === config.pipeline_id);
  return (
    <div className="space-y-2">
      <Label htmlFor="fol-contato">{t("Contato")}</Label>
      <AlvoDoBloco id="fol-contato" so="contato" valor={config.contato} onChange={(contato) => onChange({ ...config, contato })} />
      <Label htmlFor="fol-funil">{t("Funil")}</Label>
      <Select value={config.pipeline_id || undefined} onValueChange={(v) => onChange({ ...config, pipeline_id: v, stage_id: "" })}>
        <SelectTrigger id="fol-funil" aria-invalid={!config.pipeline_id}>
          <SelectValue placeholder={t("Escolha um funil")} />
        </SelectTrigger>
        <SelectContent>
          {funis.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.nome}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="fol-criar">{t("Criar o negócio se não achar")}</Label>
        <Switch id="fol-criar" checked={config.criar} onCheckedChange={(criar) => onChange({ ...config, criar })} />
      </div>
      {config.criar && (
        <>
          <Label htmlFor="fol-etapa">{t("Etapa de entrada")}</Label>
          <Select value={config.stage_id || undefined} onValueChange={(v) => onChange({ ...config, stage_id: v })}>
            <SelectTrigger id="fol-etapa" aria-invalid={!config.stage_id}>
              <SelectValue placeholder={t("Escolha uma etapa")} />
            </SelectTrigger>
            <SelectContent>
              {(funil?.etapas ?? [])
                .filter((e) => !e.isPerda)
                .map((e) => (
                  <SelectItem key={e.stageId} value={e.stageId}>
                    {e.stageName}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="fol-titulo">{t("Título do negócio novo")}</Label>
            <InserirVariavel
              soBlocos
              onInserir={(m) => onChange({ ...config, titulo: inserirNoCursor(titulo.current, config.titulo, m) })}
            />
          </div>
          <Input
            id="fol-titulo"
            ref={titulo}
            value={config.titulo}
            maxLength={200}
            placeholder={t("Vazio = nome do contato")}
            onChange={(e) => onChange({ ...config, titulo: e.target.value })}
          />
        </>
      )}
      <p className="text-xs text-text-muted">{t("Os blocos seguintes podem agir sobre este negócio pela opção «Aplicar em».")}</p>
    </div>
  );
}
