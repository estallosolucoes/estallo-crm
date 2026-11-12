"use client";

import { useState, type ReactNode } from "react";

import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import type { EntidadeDeEtiqueta, LinhaDeVocabulario } from "@/lib/schemas/tags";
import { CORES_DA_MARCA, NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { FloppyDisk, Palette, Target, TextT, User, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export type SalvarTag = (dados: {
  nome: string;
  entidade: EntidadeDeEtiqueta;
  cor: string | null;
}) => Promise<void>;

function Secao({ icone, titulo, children }: { icone: ReactNode; titulo: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent/10 text-accent">{icone}</span>
        <span className="text-sm font-medium">{titulo}</span>
      </div>
      {children}
    </div>
  );
}

function Amostras({
  cores,
  nomes,
  escolhida,
  onEscolher,
}: {
  cores: readonly string[];
  nomes: Readonly<Record<string, string>>;
  escolhida: string | null;
  onEscolher: (cor: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {cores.map((cor) => (
        <button
          key={cor}
          type="button"
          onClick={() => onEscolher(cor)}
          aria-pressed={escolhida === cor}
          // O nome é o rótulo acessível; a cor é reforço (quem não distingue
          // matiz escolhe por "Azul Estallo").
          aria-label={t(nomes[cor] ?? cor)}
          title={t(nomes[cor] ?? cor)}
          className={cn(
            "size-10 rounded-xl transition-transform",
            escolhida === cor
              ? "ring-2 ring-accent ring-offset-2 ring-offset-background"
              : "hover:scale-105",
          )}
          style={{ backgroundColor: cor }}
        />
      ))}
    </div>
  );
}

/** "Nova Tag" / "Editar Tag": nome, entidade (travada na edição) e cor com prévia. */
export function DialogoDeTag({
  aberto,
  aoFechar,
  linha,
  entidadeInicial,
  salvando,
  aoSalvar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  linha: LinhaDeVocabulario | null;
  entidadeInicial: EntidadeDeEtiqueta;
  salvando: boolean;
  aoSalvar: SalvarTag;
}) {
  const t = useT();
  const [nome, setNome] = useState(linha?.tag ?? "");
  const [entidade, setEntidade] = useState<EntidadeDeEtiqueta>(linha?.entidade ?? entidadeInicial);
  const [cor, setCor] = useState<string | null>(linha?.cor ?? Object.keys(CORES_DA_MARCA)[0] ?? null);
  const nomeLimpo = nome.trim();

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-w-md gap-0 p-0" data-testid="dialogo-tag">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle className="text-xl">{linha ? t("Editar Tag") : t("Nova Tag")}</DialogTitle>
        </DialogHeader>

        <form
          className="space-y-5 px-6 py-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (nomeLimpo) void aoSalvar({ nome: nomeLimpo, entidade, cor });
          }}
        >
          <Secao icone={<TextT size={16} aria-hidden />} titulo={t("Nome da Tag")}>
            <Input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex: Urgente, VIP, Retorno...")}
              aria-label={t("Nome da Tag")}
              maxLength={60}
              autoFocus
              className="h-11"
            />
          </Secao>

          <Secao icone={<Target size={16} aria-hidden />} titulo={t("Entidade")}>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("Entidade")}>
              {(["lead", "contact"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={entidade === e}
                  disabled={linha !== null}
                  onClick={() => setEntidade(e)}
                  className={cn(
                    "flex h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed",
                    entidade === e
                      ? "bg-accent/10 text-accent ring-1 ring-accent/30"
                      : "bg-muted/50 text-muted-foreground hover:bg-muted disabled:opacity-50",
                  )}
                >
                  {e === "lead" ? <Target size={16} aria-hidden /> : <User size={16} aria-hidden />}
                  {e === "lead" ? t("Oportunidade") : t("Contato")}
                </button>
              ))}
            </div>
          </Secao>

          <Secao icone={<Palette size={16} aria-hidden />} titulo={t("Cor da Tag")}>
            <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <ChipDeEtiqueta
                tag={nomeLimpo || t("Prévia")}
                cor={cor}
                className="rounded-full px-3 py-1 text-xs font-semibold"
              />
              <span className="text-xs text-muted-foreground">{t("Pré-visualização")}</span>
              {cor && (
                <button
                  type="button"
                  onClick={() => setCor(null)}
                  className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  {t("Sem cor")}
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("Cores da marca")}</p>
            <Amostras cores={Object.keys(CORES_DA_MARCA)} nomes={CORES_DA_MARCA} escolhida={cor} onEscolher={setCor} />
            <p className="text-xs text-muted-foreground">{t("Cores adicionais")}</p>
            <Amostras cores={PALETA_DE_ETIQUETAS} nomes={NOME_DO_TOM} escolhida={cor} onEscolher={setCor} />
          </Secao>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={aoFechar}>
              <X size={16} className="mr-1" aria-hidden /> {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!nomeLimpo || salvando} data-testid="salvar-tag">
              <FloppyDisk size={16} className="mr-1" aria-hidden />
              {linha ? t("Salvar") : t("Criar")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
