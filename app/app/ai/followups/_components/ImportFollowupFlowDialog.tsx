"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { Candidatos } from "@/lib/followup/referencias-do-pacote";
import type { Pacote } from "@/lib/followup/pacote";
import { useT } from "@/hooks/i18n/useT";

interface Previa {
  nome: string;
  origem: Pacote["origem"];
  blocos: number;
  dependencias: Pacote["dependencias"];
  candidatos: Candidatos;
}

/** O que cada tipo de referência é, para a pessoa — literal por ramo (cerca de i18n). */
function RotuloDoTipo({ tipo }: { tipo: Pacote["dependencias"][number]["tipo"] }) {
  const t = useT();
  if (tipo === "etapa") return <>{t("Etapa")}</>;
  if (tipo === "funil") return <>{t("Funil")}</>;
  if (tipo === "usuario") return <>{t("Pessoa da equipe")}</>;
  if (tipo === "tipo_de_agenda") return <>{t("Tipo de agendamento")}</>;
  if (tipo === "conexao_http") return <>{t("Conexão HTTP")}</>;
  if (tipo === "agente") return <>{t("Agente de IA")}</>;
  return <>{t("Referência desconhecida")}</>;
}

/**
 * Importar (Fase 7): escolher o arquivo → prévia (nome, origem, blocos) e o remapeamento de cada referência externa
 * para o equivalente DESTA organização, sempre escolhido (nome igual não vincula sozinho) → um rascunho novo.
 * Nada é gravado antes do «Importar»; importar não publica nem dispara o fluxo.
 */
export function ImportFollowupFlowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const [arquivo, setArquivo] = useState<string | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [mapa, setMapa] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState(false);

  const fechar = (v: boolean) => {
    if (!v) {
      setArquivo(null);
      setPrevia(null);
      setMapa({});
    }
    onOpenChange(v);
  };

  const ler = async (file: File | undefined) => {
    if (!file) return;
    setOcupado(true);
    try {
      const texto = await file.text();
      const res = await apiClient.post<{ data: Previa }>("/api/v1/ai/followup-flows/import", { modo: "previa", arquivo: texto });
      setArquivo(texto);
      setPrevia(res.data);
      setMapa({});
    } catch (err) {
      showApiError(err);
    } finally {
      setOcupado(false);
    }
  };

  const importar = async () => {
    if (!arquivo) return;
    setOcupado(true);
    try {
      const res = await apiClient.post<{ data: { id: string; name: string } }>("/api/v1/ai/followup-flows/import", {
        modo: "criar",
        arquivo,
        mapa,
      });
      toast.success(t("Automação importada como rascunho."));
      void qc.invalidateQueries({ queryKey: ["followup", "flows"] });
      fechar(false);
      router.push(`/app/ai/followups/${res.data.id}`);
    } catch (err) {
      showApiError(err);
    } finally {
      setOcupado(false);
    }
  };

  const faltam = previa ? previa.dependencias.filter((d) => d.tipo === "desconhecido" || !mapa[d.id]).length : 0;

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="importar-fluxo-dialogo">
        <DialogHeader>
          <DialogTitle>{t("Importar automação")}</DialogTitle>
          <DialogDescription>
            {t("Escolha um arquivo exportado pelo Estallo. Ele vira um rascunho novo: nada é publicado nem disparado.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="file"
            accept="application/json,.json"
            aria-label={t("Arquivo da automação")}
            disabled={ocupado}
            onChange={(e) => void ler(e.target.files?.[0])}
            data-testid="importar-arquivo"
          />
          {previa && (
            <div className="space-y-3" data-testid="importar-previa">
              <p className="text-sm">
                <span className="font-medium">{previa.nome}</span> · {previa.blocos} {t("blocos")} ·{" "}
                {previa.origem.tipo === "versao"
                  ? `${t("Versão")} ${previa.origem.versao_numero ?? ""}`
                  : t("Rascunho salvo")}
              </p>
              {previa.dependencias.length === 0 ? (
                <p className="text-xs text-text-muted">{t("O fluxo não cita etapas, pessoas nem outros itens desta organização.")}</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-text-muted">
                    {t("Escolha o equivalente, nesta organização, de cada item que o fluxo cita.")}
                  </p>
                  {previa.dependencias.map((d) => (
                    <div key={d.id} className="space-y-1" data-testid="importar-dependencia">
                      <Label className="text-xs">
                        <RotuloDoTipo tipo={d.tipo} />: {d.nome}
                      </Label>
                      {d.tipo === "desconhecido" ? (
                        <p className="text-xs text-error-fg">
                          {t("Esta versão não sabe remapear esta referência. Remova-a do fluxo de origem e exporte de novo.")}
                        </p>
                      ) : (
                        <Select value={mapa[d.id]} onValueChange={(v) => setMapa((m) => ({ ...m, [d.id]: v }))}>
                          <SelectTrigger aria-invalid={!mapa[d.id]}>
                            <SelectValue placeholder={t("Escolha o equivalente")} />
                          </SelectTrigger>
                          <SelectContent>
                            {previa.candidatos[d.tipo].map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.nome}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => fechar(false)}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            disabled={!previa || faltam > 0 || ocupado}
            onClick={() => void importar()}
            data-testid="importar-confirmar"
          >
            {t("Importar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
