"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { orgDaAba } from "@/lib/auth/org-da-aba";
import {
  executionRetentionUpdateSchema,
  type ExecutionRetentionView,
} from "@/lib/followup/execution-retention";

const ENDPOINT = "/api/v1/ai/followup-flows/retention";

function ExecutionRetentionControl({ orgId }: { orgId: string | null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const queryKey = ["followup", "execution-retention", orgId] as const;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ payload_days: string; metadata_days: string } | null>(null);
  const [validationError, setValidationError] = useState(false);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey,
    enabled: open,
    queryFn: async ({ signal }) =>
      (await apiClient.get<{ data: ExecutionRetentionView }>(ENDPOINT, { signal })).data,
  });
  const mutation = useMutation({
    mutationFn: async (policy: ExecutionRetentionView["policy"]) =>
      (await apiClient.patch<{ data: ExecutionRetentionView }>(ENDPOINT, policy)).data,
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
      setDraft(null);
      setSaved(true);
    },
  });
  const fields = draft ?? {
    payload_days: String(query.data?.policy.payload_days ?? ""),
    metadata_days: String(query.data?.policy.metadata_days ?? ""),
  };
  const updateField = (field: keyof typeof fields, value: string) => {
    setDraft({ ...fields, [field]: value });
    setSaved(false);
    setValidationError(false);
    mutation.reset();
  };
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setDraft(null);
    setSaved(false);
    setValidationError(false);
    mutation.reset();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = executionRetentionUpdateSchema.safeParse({
      payload_days: Number(fields.payload_days),
      metadata_days: Number(fields.metadata_days),
    });
    setValidationError(!parsed.success);
    if (parsed.success) mutation.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full sm:w-auto">
          {t("Retenção do histórico")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Retenção do histórico")}</DialogTitle>
          <DialogDescription>
            {t(
              "Defina por quanto tempo sua empresa mantém os dados das automações após cada execução terminar.",
            )}
          </DialogDescription>
        </DialogHeader>
        {query.isPending && <p className="text-sm text-text-muted">{t("Carregando…")}</p>}
        {query.isError && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-error-fg">
              {t("Não foi possível carregar a retenção do histórico.")}
            </p>
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              {t("Tentar novamente")}
            </Button>
          </div>
        )}
        {query.data && !query.isError && (
          <form onSubmit={submit} className="space-y-4">
            {!query.data.configuration_valid && (
              <p role="alert" className="text-sm text-warning-fg">
                {t(
                  "A configuração salva é inválida. Os prazos padrão estão em uso; salve para corrigir.",
                )}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="execution-payload-retention">{t("Dados das etapas (dias)")}</Label>
              <Input
                id="execution-payload-retention"
                type="number"
                min={query.data.limits.payload_min}
                max={query.data.limits.payload_max}
                step={1}
                required
                value={fields.payload_days}
                disabled={mutation.isPending}
                onChange={(event) => updateField("payload_days", event.target.value)}
                aria-describedby="execution-payload-retention-help"
              />
              <p id="execution-payload-retention-help" className="text-xs text-text-muted">
                {t(
                  "Inclui entradas e saídas das etapas. Após esse prazo, os dados deixam de estar disponíveis para consulta e recuperação.",
                )}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="execution-metadata-retention">
                {t("Histórico de execuções (dias)")}
              </Label>
              <Input
                id="execution-metadata-retention"
                type="number"
                min={query.data.limits.metadata_min}
                max={query.data.limits.metadata_max}
                step={1}
                required
                value={fields.metadata_days}
                disabled={mutation.isPending}
                onChange={(event) => updateField("metadata_days", event.target.value)}
              />
            </div>
            <p className="text-xs text-text-muted">
              {t("Execuções em andamento e dados necessários para continuá-las são preservados.")}
            </p>
            <p className="text-xs text-text-muted">
              {t(
                "Os prazos valem para execuções com histórico detalhado. Fluxos antigos mantêm o histórico existente.",
              )}
            </p>
            <p className="text-xs text-text-muted">
              {t("Se reduzir o prazo, dados antigos poderão ser apagados na próxima limpeza.")}
            </p>
            {validationError && (
              <p role="alert" className="text-sm text-error-fg">
                {t("O histórico deve ser mantido por pelo menos o prazo dos dados detalhados.")}
              </p>
            )}
            {mutation.isError && (
              <p role="alert" className="text-sm text-error-fg">
                {t("Não foi possível salvar a retenção do histórico.")}
              </p>
            )}
            {saved && (
              <p role="status" className="text-sm text-success-fg">
                {t("Configuração salva.")}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => changeOpen(false)}
                disabled={mutation.isPending}
              >
                {t("Fechar")}
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? t("Salvando…") : t("Salvar")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A troca de empresa desmonta o formulário e mantém caches separados. */
export function ExecutionRetentionButton() {
  const orgId = orgDaAba()?.orgId ?? null;
  return <ExecutionRetentionControl key={orgId} orgId={orgId} />;
}
