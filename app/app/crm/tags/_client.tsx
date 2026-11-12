"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { invalidarCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { EntidadeDeEtiqueta, LinhaDeVocabulario } from "@/lib/schemas/tags";
import { nomeDaCor } from "@/lib/tags/cor-da-etiqueta";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { MagnifyingGlass, PencilSimple, Plus, Target, Trash, User } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { DialogoDeTag, type SalvarTag } from "./_dialogo";

const CHAVE = ["tags-vocabulario"] as const;

/**
 * O teto da lista: `fn_vocabulario_de_tags` termina em `limit 1000` (0659), e
 * lista truncada em silêncio lê como completa — por isso a tela avisa.
 * `tests/unit/tags-vocabulario.test.ts` liga este número ao do SQL.
 */
const TETO_DA_LISTA = 1000;

type Operacao = {
  acao: "criar" | "renomear" | "excluir" | "definir_cor";
  entidade: EntidadeDeEtiqueta;
  tag: string;
  destino?: string | null;
  cor?: string | null;
};

export function TagsClient() {
  const t = useT();
  const qc = useQueryClient();
  const [aba, setAba] = useState<EntidadeDeEtiqueta>("lead");
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<LinhaDeVocabulario | "nova" | null>(null);
  const [apagando, setApagando] = useState<LinhaDeVocabulario | null>(null);

  const lista = useQuery({
    queryKey: CHAVE,
    queryFn: async () =>
      (await apiClient.get<{ data: LinhaDeVocabulario[] }>("/api/v1/tags/vocabulario")).data,
  });

  const operar = useMutation({
    mutationFn: (op: Operacao) =>
      apiClient.post("/api/v1/tags/vocabulario", { destino: null, ...op }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      // O chip do inbox, do funil e dos contatos lê o mapa do provider.
      invalidarCoresDasEtiquetas(qc);
    },
  });

  function erro(e: unknown) {
    const codigo = e instanceof ApiError ? e.code : "";
    toast.error(
      codigo === "conflict"
        ? t("Já existe uma etiqueta com esse nome.")
        : codigo === "forbidden" || codigo === "forbidden_role"
          ? t("Só um gerente ou administrador pode mudar as etiquetas.")
          : codigo === "mfa_required"
            ? t("Confirme o segundo fator para mudar as etiquetas.")
            : t("Não foi possível concluir agora. Tente de novo."),
    );
  }

  const salvar: SalvarTag = async ({ nome, entidade, cor }) => {
    try {
      if (editando === "nova") {
        await operar.mutateAsync({ acao: "criar", entidade, tag: nome, cor });
        toast.success(t("Tag criada."));
      } else if (editando) {
        let atual = editando.tag;
        if (nome !== editando.tag) {
          await operar.mutateAsync({ acao: "renomear", entidade, tag: editando.tag, destino: nome });
          atual = nome;
        }
        if ((cor ?? null) !== (editando.cor ?? null) || !editando.no_vocabulario) {
          await operar.mutateAsync({ acao: "definir_cor", entidade, tag: atual, cor });
        }
        toast.success(t("Tag atualizada."));
      }
      setEditando(null);
    } catch (e) {
      erro(e);
    }
  };

  async function excluir(linha: LinhaDeVocabulario) {
    try {
      await operar.mutateAsync({ acao: "excluir", entidade: linha.entidade, tag: linha.tag });
      toast.success(t("Tag excluída."));
    } catch (e) {
      erro(e);
    } finally {
      setApagando(null);
    }
  }

  const linhas = useMemo(() => lista.data ?? [], [lista.data]);
  const contagem = (e: EntidadeDeEtiqueta) => linhas.filter((l) => l.entidade === e).length;
  const termo = busca.trim().toLowerCase();
  const visiveis = linhas
    .filter((l) => l.entidade === aba)
    .filter((l) => !termo || l.tag.toLowerCase().includes(termo));

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Tags")}</h1>
        <div className="relative min-w-60 flex-1">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Buscar tags")}
            aria-label={t("Buscar tags")}
            className="rounded-full pl-9"
          />
        </div>
        <Button onClick={() => setEditando("nova")} data-testid="nova-tag">
          <Plus size={16} className="mr-1" aria-hidden /> {t("Nova Tag")}
        </Button>
      </div>

      <div className="flex gap-2" role="tablist">
        {(["lead", "contact"] as const).map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            aria-selected={aba === e}
            onClick={() => setAba(e)}
            data-testid={`aba-tags-${e}`}
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium",
              aba === e ? "bg-accent/15 text-accent" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {e === "lead" ? <Target size={14} aria-hidden /> : <User size={14} aria-hidden />}
            {e === "lead" ? t("Oportunidade") : t("Contato")}
            <span
              className={cn(
                "rounded-full px-1.5 text-xs",
                aba === e ? "bg-accent dark:bg-accent-700 text-accent-foreground" : "bg-muted",
              )}
            >
              {contagem(e)}
            </span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5">{t("Tag")}</th>
              <th className="px-4 py-2.5">{t("Cor")}</th>
              <th className="px-4 py-2.5 text-right">{t("Ações")}</th>
            </tr>
          </thead>
          <tbody>
            {lista.isLoading ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  {t("Carregando…")}
                </td>
              </tr>
            ) : lista.isError ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-destructive">
                  {t("Não foi possível carregar as etiquetas agora. Recarregue a página.")}
                </td>
              </tr>
            ) : visiveis.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  {t("Nenhuma tag ainda. Crie a primeira em “Nova Tag”.")}
                </td>
              </tr>
            ) : (
              visiveis.map((l) => {
                const nome = nomeDaCor(l.cor);
                return (
                  <tr
                    key={`${l.entidade}:${l.tag}`}
                    className="border-t border-border"
                    data-testid={`tag-${l.entidade}-${l.tag}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="size-4 shrink-0 rounded-full border border-border"
                          style={l.cor ? { backgroundColor: l.cor, borderColor: l.cor } : undefined}
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{l.tag}</div>
                          <div className="text-xs text-muted-foreground">
                            {l.uso} {l.uso === 1 ? t("registro") : t("registros")}
                            {l.em_regras > 0 &&
                              ` · ${l.em_regras} ${l.em_regras === 1 ? t("regra de automação") : t("regras de automação")}`}
                            {!l.no_vocabulario && ` · ${t("em uso, fora do cadastro")}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {nome ? (
                        <ChipDeEtiqueta
                          tag={nome}
                          cor={l.cor}
                          className="rounded-full px-3 py-1 text-xs font-semibold"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("Sem cor")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={`${t("Editar")} ${l.tag}`}
                        onClick={() => setEditando(l)}
                      >
                        <PencilSimple size={16} aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={`${t("Excluir")} ${l.tag}`}
                        onClick={() => setApagando(l)}
                      >
                        <Trash size={16} aria-hidden />
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {linhas.length >= TETO_DA_LISTA && (
        <p className="text-sm text-muted-foreground">
          {t(
            "Mostrando as 1000 primeiras etiquetas em ordem alfabética. Se a que você procura não está aqui, arrume primeiro as que aparecem.",
          )}
        </p>
      )}

      <AlertDialog open={apagando !== null} onOpenChange={(v) => !v && setApagando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir a tag")} «{apagando?.tag}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {apagando?.uso ?? 0} {t("registro(s) perdem esta tag. Não dá para desfazer.")}
              {apagando && apagando.em_regras > 0 && (
                <>
                  {" "}
                  {apagando.em_regras}{" "}
                  {t(
                    "regra(s) de automação continuam escrevendo esta tag — excluir aqui não apaga a regra, e ela recria a tag no próximo disparo.",
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => apagando && void excluir(apagando)}
              disabled={operar.isPending}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editando && (
        <DialogoDeTag
          aberto
          aoFechar={() => setEditando(null)}
          linha={editando === "nova" ? null : editando}
          entidadeInicial={aba}
          salvando={operar.isPending}
          aoSalvar={salvar}
        />
      )}
    </div>
  );
}
