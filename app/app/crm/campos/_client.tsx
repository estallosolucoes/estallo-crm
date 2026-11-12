"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import {
  useApagarCampo,
  useCamposPersonalizados,
  useEditarCampo,
  type FunilDosCampos,
} from "@/hooks/campos/useCamposPersonalizados";
import type { DefinicaoDeCampo, EntidadeDeCampo } from "@/lib/campos/definicao";
import { CaretDown, EyeSlash, Funnel, MagnifyingGlass, PencilSimple, Plus, Trash, Users } from "@/lib/ui/icons";
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
import { cn } from "@/lib/utils";
import { EditorDeCampo, ROTULO_DO_TIPO } from "./_editor";

/** Meio caminho entre as vizinhas: a ordem é `numeric` (fractional indexing). */
function posicaoEntre(antes: number | undefined, depois: number | undefined): number {
  if (antes === undefined && depois === undefined) return 1000;
  if (antes === undefined) return (depois as number) - 1000;
  if (depois === undefined) return antes + 1000;
  return (antes + depois) / 2;
}

export function contagemDeEtapas(d: DefinicaoDeCampo, funis: FunilDosCampos[]): number {
  const etapasDosFunis = funis
    .filter((f) => d.funis_visiveis.includes(f.id))
    .reduce((n, f) => n + f.etapas.length, 0);
  return etapasDosFunis + d.etapas_visiveis.length;
}

export function CamposPersonalizadosClient() {
  const t = useT();
  const [aba, setAba] = useState<EntidadeDeCampo>("lead");
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<DefinicaoDeCampo | "novo" | null>(null);
  const [ocultosAbertos, setOcultosAbertos] = useState(false);
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [apagando, setApagando] = useState<DefinicaoDeCampo | null>(null);
  const lista = useCamposPersonalizados();
  const editar = useEditarCampo();
  const apagar = useApagarCampo();

  const definicoes = useMemo(() => lista.data?.definicoes ?? [], [lista.data]);
  const funis = lista.data?.funis ?? [];
  const daAba = definicoes.filter((d) => d.entity === aba);
  const termo = busca.trim().toLowerCase();
  const filtradas = daAba.filter((d) => !termo || d.label.toLowerCase().includes(termo));
  const visiveis = filtradas.filter((d) => !d.hidden);
  const ocultas = filtradas.filter((d) => d.hidden);
  const contagem = (e: EntidadeDeCampo) => definicoes.filter((d) => d.entity === e).length;

  function soltarSobre(alvo: DefinicaoDeCampo) {
    if (!arrastando || arrastando === alvo.id) return;
    const ordem = visiveis.filter((d) => d.id !== arrastando);
    const i = ordem.findIndex((d) => d.id === alvo.id);
    const posicao = posicaoEntre(ordem[i - 1]?.position, ordem[i]?.position);
    editar.mutate({ id: arrastando, patch: { position: posicao } });
    setArrastando(null);
  }

  function rotuloDaVisibilidade(d: DefinicaoDeCampo): string {
    if (d.visivel_global) return t("Global");
    const n = contagemDeEtapas(d, funis);
    return n === 1 ? t("1 etapa") : `${n} ${t("etapas")}`;
  }

  function rotuloDoObrigatorio(d: DefinicaoDeCampo): string {
    if (d.obrigatorio === "empresa") return t("Empresa toda");
    if (d.obrigatorio === "etapas") {
      const n = d.etapas_obrigatorias.length;
      return n === 1 ? t("1 etapa") : `${n} ${t("etapas")}`;
    }
    return t("Não");
  }

  const linha = (d: DefinicaoDeCampo) => (
    <tr
      key={d.id}
      draggable={!d.hidden}
      onDragStart={() => setArrastando(d.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => soltarSobre(d)}
      className={cn("border-t border-border", arrastando === d.id && "opacity-50")}
      data-testid={`campo-${d.key}`}
    >
      <td className="w-8 px-3 py-3 text-muted-foreground">
        {!d.hidden && <span className="cursor-grab select-none" aria-hidden>⋮⋮</span>}
      </td>
      <td className="px-3 py-3 font-medium">{d.label}</td>
      <td className="px-3 py-3 text-xs uppercase text-muted-foreground">{t(ROTULO_DO_TIPO[d.type])}</td>
      <td className="px-3 py-3">
        <Badge variant={d.visivel_global ? "secondary" : "outline"}>{rotuloDaVisibilidade(d)}</Badge>
      </td>
      <td className="px-3 py-3">
        <Badge variant="secondary">{rotuloDoObrigatorio(d)}</Badge>
      </td>
      <td className="px-3 py-3 text-right">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={`${t("Editar")} ${d.label}`}
          onClick={() => setEditando(d)}
        >
          <PencilSimple size={16} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={`${t("Apagar")} ${d.label}`}
          disabled={apagar.isPending}
          onClick={() => setApagando(d)}
        >
          <Trash size={16} aria-hidden />
        </Button>
      </td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Campos personalizados")}</h1>
        <div className="relative min-w-60 flex-1">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Buscar campos")}
            aria-label={t("Buscar campos")}
            className="rounded-full pl-9"
          />
        </div>
        <Button onClick={() => setEditando("novo")} data-testid="novo-campo">
          <Plus size={16} className="mr-1" aria-hidden /> {t("Novo Campo")}
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
            className={cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium",
              aba === e ? "bg-accent/15 text-accent" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {e === "lead" ? <Funnel size={14} aria-hidden /> : <Users size={14} aria-hidden />}
            {e === "lead" ? t("Oportunidade") : t("Contato")}
            <span className="rounded-full bg-muted px-1.5 text-xs">{contagem(e)}</span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2" />
              <th className="px-3 py-2">{t("Nome")}</th>
              <th className="px-3 py-2">{t("Tipo")}</th>
              <th className="px-3 py-2">{t("Visibilidade")}</th>
              <th className="px-3 py-2">{t("Obrigatório")}</th>
              <th className="px-3 py-2 text-right">{t("Ações")}</th>
            </tr>
          </thead>
          <tbody>
            {lista.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  {t("Carregando…")}
                </td>
              </tr>
            ) : visiveis.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  {t("Nenhum campo ainda. Crie o primeiro em “Novo Campo”.")}
                </td>
              </tr>
            ) : (
              visiveis.map(linha)
            )}
            {ocultas.length > 0 && (
              <tr className="border-t border-border bg-muted/40">
                <td colSpan={6} className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setOcultosAbertos((v) => !v)}
                    aria-expanded={ocultosAbertos}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <CaretDown size={14} className={cn(!ocultosAbertos && "-rotate-90")} aria-hidden />
                    <EyeSlash size={14} aria-hidden />
                    {t("Campos Ocultos")}
                    <span className="rounded-full bg-muted px-1.5 text-xs">{ocultas.length}</span>
                  </button>
                </td>
              </tr>
            )}
            {ocultosAbertos && ocultas.map(linha)}
          </tbody>
        </table>
      </div>

      <AlertDialog open={apagando !== null} onOpenChange={(v) => !v && setApagando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Apagar este campo?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Ele some dos formulários. Os valores já preenchidos continuam guardados — para só esconder, use “Ocultar”.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => apagando && apagar.mutate(apagando.id)}>
              {t("Apagar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editando && (
        <EditorDeCampo
          aberto
          aoFechar={() => setEditando(null)}
          entidade={aba}
          definicao={editando === "novo" ? null : editando}
          funis={funis}
        />
      )}
    </div>
  );
}
