"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  useCriarCampo,
  useEditarCampo,
  type FunilDosCampos,
} from "@/hooks/campos/useCamposPersonalizados";
import type { DefinicaoDeCampo, EntidadeDeCampo, TipoDeCampo } from "@/lib/campos/definicao";

export const ROTULO_DO_TIPO: Record<TipoDeCampo, string> = {
  text: "Texto",
  textarea: "Texto longo",
  number: "Número",
  currency: "Valor (R$)",
  date: "Data",
  select: "Lista",
  multiselect: "Lista (vários)",
  boolean: "Sim/Não",
  email: "E-mail",
  phone: "Telefone",
  url: "Link",
};

const TEM_OPCOES = (tipo: TipoDeCampo) => tipo === "select" || tipo === "multiselect";

/**
 * A árvore funil → etapas com caixas de marcar. Marcar o funil = o funil
 * inteiro (inclui etapas criadas depois); marcar etapas soltas = só elas.
 */
function ArvoreDeEtapas({
  funis,
  funisMarcados,
  etapasMarcadas,
  aoMudar,
  permiteFunilInteiro,
  soAbertas,
  prefixo,
}: {
  funis: FunilDosCampos[];
  funisMarcados: string[];
  etapasMarcadas: string[];
  aoMudar: (funis: string[], etapas: string[]) => void;
  permiteFunilInteiro: boolean;
  soAbertas?: boolean;
  prefixo: string;
}) {
  const t = useT();
  if (funis.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("Nenhum funil ainda.")}</p>;
  }
  return (
    <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-2">
      {funis.map((f) => {
        const funilInteiro = funisMarcados.includes(f.id);
        const etapas = soAbertas ? f.etapas.filter((e) => !e.is_won && !e.is_lost) : f.etapas;
        return (
          <div key={f.id} className="space-y-1">
            <label className="flex items-center gap-2 text-sm font-medium">
              {permiteFunilInteiro ? (
                <input
                  type="checkbox"
                  checked={funilInteiro}
                  onChange={(e) =>
                    aoMudar(
                      e.target.checked
                        ? [...funisMarcados, f.id]
                        : funisMarcados.filter((id) => id !== f.id),
                      // Funil inteiro marcado: as etapas soltas dele deixam de importar.
                      etapasMarcadas.filter((id) => !f.etapas.some((et) => et.id === id)),
                    )
                  }
                  data-testid={`${prefixo}-funil-${f.id}`}
                />
              ) : null}
              {f.name}
            </label>
            <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
              {etapas.map((e) => (
                <label key={e.id} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    disabled={funilInteiro}
                    checked={funilInteiro || etapasMarcadas.includes(e.id)}
                    onChange={(ev) =>
                      aoMudar(
                        funisMarcados,
                        ev.target.checked
                          ? [...etapasMarcadas, e.id]
                          : etapasMarcadas.filter((id) => id !== e.id),
                      )
                    }
                  />
                  {e.name}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EditorDeCampo({
  aberto,
  aoFechar,
  entidade,
  definicao,
  funis,
}: {
  aberto: boolean;
  aoFechar: () => void;
  entidade: EntidadeDeCampo;
  definicao: DefinicaoDeCampo | null;
  funis: FunilDosCampos[];
}) {
  const t = useT();
  const criar = useCriarCampo();
  const editar = useEditarCampo();
  const [rotulo, setRotulo] = useState(definicao?.label ?? "");
  const [tipo, setTipo] = useState<TipoDeCampo>(definicao?.type ?? "text");
  const [opcoes, setOpcoes] = useState(
    (definicao?.options ?? []).map((o) => o.label).join("\n"),
  );
  const [global, setGlobal] = useState(definicao?.visivel_global ?? true);
  const [funisVisiveis, setFunisVisiveis] = useState(definicao?.funis_visiveis ?? []);
  const [etapasVisiveis, setEtapasVisiveis] = useState(definicao?.etapas_visiveis ?? []);
  const [obrigatorio, setObrigatorio] = useState(definicao?.obrigatorio ?? "nao");
  const [etapasObrigatorias, setEtapasObrigatorias] = useState(definicao?.etapas_obrigatorias ?? []);
  const [aoGanhar, setAoGanhar] = useState(definicao?.obrigatorio_ao_ganhar ?? false);
  const [aoPerder, setAoPerder] = useState(definicao?.obrigatorio_ao_perder ?? false);
  const [oculto, setOculto] = useState(definicao?.hidden ?? false);
  const [erro, setErro] = useState<string | null>(null);
  const salvando = criar.isPending || editar.isPending;
  const ehLead = (definicao?.entity ?? entidade) === "lead";

  async function salvar() {
    if (!rotulo.trim()) return setErro(t("Dê um nome ao campo."));
    const listaDeOpcoes = opcoes
      .split("\n")
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => ({ value: o, label: o }));
    if (TEM_OPCOES(tipo) && listaDeOpcoes.length === 0) {
      return setErro(t("Lista de opções precisa de pelo menos uma opção."));
    }
    if (!global && funisVisiveis.length === 0 && etapasVisiveis.length === 0) {
      return setErro(t("Escolha pelo menos um funil ou etapa onde o campo aparece."));
    }
    const corpo = {
      label: rotulo.trim(),
      type: tipo,
      options: TEM_OPCOES(tipo) ? listaDeOpcoes : [],
      hidden: oculto,
      visivel_global: global,
      funis_visiveis: global ? [] : funisVisiveis,
      etapas_visiveis: global ? [] : etapasVisiveis,
      obrigatorio,
      etapas_obrigatorias: obrigatorio === "etapas" ? etapasObrigatorias : [],
      obrigatorio_ao_ganhar: ehLead && aoGanhar,
      obrigatorio_ao_perder: ehLead && aoPerder,
    };
    setErro(null);
    try {
      if (definicao) await editar.mutateAsync({ id: definicao.id, patch: corpo });
      else await criar.mutateAsync({ ...corpo, entity: entidade });
      aoFechar();
    } catch {
      // o hook já mostrou o erro
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{definicao ? t("Editar campo") : t("Novo campo")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <div className="space-y-1.5">
              <Label htmlFor="campo-nome">{t("Nome")}</Label>
              <Input
                id="campo-nome"
                autoFocus
                value={rotulo}
                onChange={(e) => setRotulo(e.target.value)}
                placeholder={t("Ex.: Qual é sua maior dificuldade hoje?")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campo-tipo">{t("Tipo")}</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as TipoDeCampo)}>
                <SelectTrigger id="campo-tipo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROTULO_DO_TIPO) as TipoDeCampo[]).map((tp) => (
                    <SelectItem key={tp} value={tp}>
                      {t(ROTULO_DO_TIPO[tp])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {TEM_OPCOES(tipo) && (
            <div className="space-y-1.5">
              <Label htmlFor="campo-opcoes">{t("Opções (uma por linha)")}</Label>
              <Textarea
                id="campo-opcoes"
                rows={4}
                value={opcoes}
                onChange={(e) => setOpcoes(e.target.value)}
              />
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Onde aparece")}</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={global} onChange={() => setGlobal(true)} />
                {t("Global (todos os funis)")}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={!global}
                  onChange={() => setGlobal(false)}
                  data-testid="campo-visibilidade-escolher"
                />
                {t("Funis e etapas escolhidos")}
              </label>
            </div>
            {!global && (
              <ArvoreDeEtapas
                funis={funis}
                funisMarcados={funisVisiveis}
                etapasMarcadas={etapasVisiveis}
                permiteFunilInteiro
                prefixo="visivel"
                aoMudar={(f, e) => {
                  setFunisVisiveis(f);
                  setEtapasVisiveis(e);
                }}
              />
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Obrigatório")}</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={obrigatorio === "nao"}
                  onChange={() => setObrigatorio("nao")}
                />
                {t("Não")}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={obrigatorio === "empresa"}
                  onChange={() => setObrigatorio("empresa")}
                />
                {t("Em toda a empresa")}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={obrigatorio === "etapas"}
                  onChange={() => setObrigatorio("etapas")}
                />
                {t("Em etapas escolhidas")}
              </label>
            </div>
            {obrigatorio === "empresa" && (
              <p className="text-xs text-muted-foreground">
                {t("O negócio só sai da primeira etapa, e só é ganho, com o campo preenchido.")}
              </p>
            )}
            {obrigatorio === "etapas" && (
              <ArvoreDeEtapas
                funis={funis}
                funisMarcados={[]}
                etapasMarcadas={etapasObrigatorias}
                permiteFunilInteiro={false}
                soAbertas
                prefixo="obrigatorio"
                aoMudar={(_f, e) => setEtapasObrigatorias(e)}
              />
            )}
            {ehLead && (
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={aoGanhar} onChange={(e) => setAoGanhar(e.target.checked)} />
                  {t("Exigir ao ganhar")}
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={aoPerder} onChange={(e) => setAoPerder(e.target.checked)} />
                  {t("Exigir ao perder")}
                </label>
              </div>
            )}
          </fieldset>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
            <span>
              <span className="font-medium">{t("Ocultar")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("Some dos formulários sem apagar o que já foi preenchido.")}
              </span>
            </span>
            <Switch checked={oculto} onCheckedChange={setOculto} />
          </label>

          {erro && (
            <p role="alert" className="rounded-md bg-destructive/10 p-2 text-xs font-medium text-destructive">
              {erro}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={aoFechar} disabled={salvando}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void salvar()} disabled={salvando} data-testid="salvar-campo">
            {salvando ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
