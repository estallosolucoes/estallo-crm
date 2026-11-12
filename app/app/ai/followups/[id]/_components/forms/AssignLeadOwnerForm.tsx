"use client";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

/**
 * Atribuir responsável (Fase 5): quem passa a cuidar do NEGÓCIO. A lista é a dos atendentes ativos da organização (a
 * mesma da tarefa). Não transfere a conversa: responsável pelo atendimento é outra coisa.
 */
export function AssignLeadOwnerForm({
  config,
  onChange,
}: {
  config: ConfigOf<"assign_lead_owner">;
  onChange: (c: ConfigOf<"assign_lead_owner">) => void;
}) {
  const t = useT();
  const { data: membros } = useAssignableMembers(true);
  return (
    <div className="space-y-2">
      <Label htmlFor="assign-lead-owner">{t("Novo responsável pelo negócio")}</Label>
      <Select value={config.usuario_id || undefined} onValueChange={(v) => onChange({ usuario_id: v })}>
        <SelectTrigger id="assign-lead-owner" aria-invalid={!config.usuario_id}>
          <SelectValue placeholder={t("Escolha um atendente")} />
        </SelectTrigger>
        <SelectContent>
          {(membros ?? []).map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.full_name ?? m.user_id.slice(0, 8)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-text-muted">
        {t("Troca só o responsável pelo negócio. A conversa continua com quem a atende.")}
      </p>
    </div>
  );
}
