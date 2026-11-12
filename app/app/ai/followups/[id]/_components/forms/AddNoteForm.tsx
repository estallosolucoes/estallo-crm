"use client";

import { useRef } from "react";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";

import { InserirVariavel, inserirNoCursor, PreviaDoTexto } from "../VariaveisDoFluxo";
import type { ConfigOf } from "./shared";

/** Nota interna (Fase 5): destino escolhido explicitamente e texto com variáveis dos blocos anteriores. */
export function AddNoteForm({
  config,
  onChange,
}: {
  config: ConfigOf<"add_note">;
  onChange: (c: ConfigOf<"add_note">) => void;
}) {
  const t = useT();
  const campo = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="space-y-2">
      <Label htmlFor="add-note-destino">{t("Onde registrar")}</Label>
      <Select
        value={config.destino}
        onValueChange={(v) => onChange({ ...config, destino: v === "conversation_notes" ? "conversation_notes" : "lead_timeline" })}
      >
        <SelectTrigger id="add-note-destino">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* Literais por ramo (cerca de i18n): os rótulos são os de `DESTINOS_DA_NOTA` (vocabulario.ts). */}
          <SelectItem value="lead_timeline">{t("No negócio (linha do tempo)")}</SelectItem>
          <SelectItem value="conversation_notes">{t("Na conversa (notas internas)")}</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="add-note-texto">{t("Texto da nota")}</Label>
        <InserirVariavel
          soBlocos
          onInserir={(marca) => onChange({ ...config, texto: inserirNoCursor(campo.current, config.texto, marca) })}
        />
      </div>
      <Textarea
        id="add-note-texto"
        ref={campo}
        value={config.texto}
        maxLength={2000}
        aria-invalid={!config.texto.trim()}
        onChange={(e) => onChange({ ...config, texto: e.target.value })}
      />
      <PreviaDoTexto texto={config.texto} />
      <p className="text-xs text-text-muted">{t("A nota é interna: o cliente nunca a vê.")}</p>
    </div>
  );
}
