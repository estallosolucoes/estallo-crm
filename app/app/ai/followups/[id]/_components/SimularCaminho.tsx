"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { flowGraphSchema, nodeBranches, type FlowGraph } from "@/lib/followup/graph-schema";
import { simularCaminho } from "@/lib/followup/simular-caminho";
import { Play } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * «Simular caminho» (Fase 6): mostra, no RASCUNHO, por onde a execução passaria e o que cada bloco faria, com dados
 * de exemplo. Nada é gravado nem enviado — o rótulo diz isso. Nos blocos de resposta e de IA, quem testa escolhe o ramo.
 */
export function SimularCaminho({ graph }: { graph: FlowGraph }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [etiquetas, setEtiquetas] = useState("");
  const [escolhas, setEscolhas] = useState<Record<string, string>>({});
  const valido = useMemo(() => flowGraphSchema.safeParse(graph), [graph]);
  const passos = useMemo(
    () =>
      aberto && valido.success
        ? simularCaminho(valido.data, {
            fatos: { tags: etiquetas.split(",").map((s) => s.trim()).filter(Boolean) },
            escolhas,
          })
        : [],
    [aberto, valido, etiquetas, escolhas],
  );
  // Os blocos em que a resposta do cliente decide o caminho: quem testa escolhe o ramo de cada um.
  const decisoes = valido.success ? valido.data.nodes.filter((n) => n.type === "ai_classify" || n.type === "match_reply") : [];

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setAberto(true)} data-testid="simular-caminho">
        <Play size={14} aria-hidden className="mr-1" />
        {t("Simular caminho")}
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="simulacao">
          <DialogHeader>
            <DialogTitle>{t("Simular caminho")}</DialogTitle>
            <DialogDescription>
              {t("Simulação com dados de exemplo: nada é gravado no CRM e nenhuma mensagem é enviada.")}
            </DialogDescription>
          </DialogHeader>
          {!valido.success ? (
            <p className="text-sm text-text-muted">{t("Complete o fluxo para simular.")}</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="simular-etiquetas">{t("Etiquetas do negócio (exemplo)")}</Label>
                <Input
                  id="simular-etiquetas"
                  value={etiquetas}
                  placeholder={t("ex.: vip, orcamento-aberto")}
                  onChange={(e) => setEtiquetas(e.target.value)}
                />
              </div>
              {decisoes.map((n) => (
                <div key={n.id} className="space-y-1">
                  <Label className="text-xs">
                    {t("Resposta em")} «{n.label}»
                  </Label>
                  <Select value={escolhas[n.id]} onValueChange={(v) => setEscolhas((e) => ({ ...e, [n.id]: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("Primeiro caminho ligado")} />
                    </SelectTrigger>
                    <SelectContent>
                      {nodeBranches(n)
                        .filter((b) => b.kind !== "error")
                        .map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.label ?? b.id}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              <ol className="space-y-2" data-testid="simulacao-passos">
                {passos.map((p, i) => (
                  <li key={`${p.no_id}-${i}`} className="rounded-md border border-border p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{p.rotulo}</span>
                      <Badge variant={p.erro ? "error" : "warning"}>{p.erro ? t("Pararia") : t("Previsto")}</Badge>
                    </div>
                    <p className="text-xs text-text-muted">{p.previsto}</p>
                    {p.texto && <p className="mt-1 whitespace-pre-wrap text-xs">«{p.texto}»</p>}
                    {p.erro && <p className="mt-1 text-xs text-error-fg">{p.erro}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
