"use client";

import { useT } from "@/hooks/i18n/useT";
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";
import { CATEGORIAS_DE_PERDA } from "@/lib/schemas/leads";
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";
import { AgentMappingSection, ancoraDoMapeamento } from "./_mapping";
import { StagesSection, ancoraDasEtapas } from "./_stages";

export interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  vocabulary: Record<string, string> | null;
  settings: Record<string, unknown> | null;
}

/**
 * Os tipos de campo que esta tela oferece — DERIVADOS do schema, nunca
 * reescritos à mão.
 *
 * Quando a lista era digitada aqui, ela encolheu sem ninguém ver: `multiselect`
 * existia em `customFieldSchema`, era gravado pela API e aparecia no dossiê
 * (`components/contacts/CustomFieldsEditor.tsx`), mas faltava nesta lista. O
 * efeito para quem abria a tela era um campo que parecia corrompido — o
 * `<Select>` recebia `value="multiselect"`, nenhum `SelectItem` casava, e o
 * seletor ficava EM BRANCO. Pior: as opções do campo só apareciam para
 * `select`, então um multiselect ficava sem como ser editado, e a saída óbvia
 * (escolher um tipo para "consertar" o branco) transformava a escolha múltipla
 * em escolha única.
 *
 * Derivar do schema faz a divergência deixar de ser possível: tipo novo lá
 * nasce oferecido aqui.
 */
export const TIPOS_DE_CAMPO = customFieldSchema.shape.type.options;

/** Tipos cujo valor sai de uma lista fechada — são os que mostram o campo de opções. */
export function tipoTemOpcoes(tipo: CustomFieldDef["type"]): boolean {
  return tipo === "select" || tipo === "multiselect";
}

/**
 * Uma etapa do funil, do jeito que o editor de `obrigatorio_em` precisa ler.
 *
 * `is_archived` entra porque a lista É COMPLETA de propósito: descartar a etapa
 * arquivada na leitura apagaria silenciosamente a marca que alguém já fez — o
 * save regrava `fields` inteiro, então o que não aparece na tela some do
 * settings. Arquivada fica visível e marcada; ela não recebe card novo, mas
 * também não é apagada por baixo de quem a marcou.
 */
export interface EtapaDoFunil {
  id: string;
  name: string;
  is_archived: boolean;
}

/**
 * A regra `obrigatorio_em` normalizada — NADA MARCADO É AUSÊNCIA, não `{}`.
 *
 * `undefined` e `{}` significam a mesma coisa para `validaCamposExigidos`, mas
 * só o primeiro deixa o settings do funil idêntico ao de antes do #1536: gravar
 * `{ etapas: [], ao_ganhar: false, ao_perder: false }` encheria todo campo de
 * uma chave morta e faria o critério de aceite nº 3 ("sem `obrigatorio_em` o
 * comportamento é o de antes") depender de olhar para dentro do objeto.
 */
export function normalizaObrigatorioEm(
  regra: CustomFieldDef["obrigatorio_em"],
): CustomFieldDef["obrigatorio_em"] {
  const etapas = regra?.etapas ?? [];
  const aoGanhar = regra?.ao_ganhar === true;
  const aoPerder = regra?.ao_perder === true;
  if (etapas.length === 0 && !aoGanhar && !aoPerder) return undefined;
  return {
    ...(etapas.length > 0 ? { etapas } : {}),
    ...(aoGanhar ? { ao_ganhar: true } : {}),
    ...(aoPerder ? { ao_perder: true } : {}),
  };
}

/** Liga/desliga UMA etapa na regra do campo, sem mexer no resto da marca. */
export function comEtapa(
  regra: CustomFieldDef["obrigatorio_em"],
  etapaId: string,
  marcada: boolean,
): CustomFieldDef["obrigatorio_em"] {
  const etapas = new Set(regra?.etapas ?? []);
  if (marcada) etapas.add(etapaId);
  else etapas.delete(etapaId);
  return normalizaObrigatorioEm({ ...regra, etapas: [...etapas] });
}

/** Liga/desliga um dos dois gatilhos de FECHAMENTO (`ao_ganhar`/`ao_perder`). */
export function comGatilho(
  regra: CustomFieldDef["obrigatorio_em"],
  gatilho: "ao_ganhar" | "ao_perder",
  marcado: boolean,
): CustomFieldDef["obrigatorio_em"] {
  return normalizaObrigatorioEm({ ...regra, [gatilho]: marcado });
}

/**
 * Os RÓTULOS cadastrados (issue #1537): `lost_reasons` aceita texto puro E
 * `{ label, categoria }`, e esta caixa é sempre rótulo — o objeto é guardado
 * aqui embaixo, na hora de salvar.
 */
function readLostReasons(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  if (!Array.isArray(r)) return [];
  return r
    .map((item) => (typeof item === "string" ? item : (item as { label?: unknown })?.label))
    .filter((v): v is string => typeof v === "string");
}

/** Rótulo → categoria gravada (issue #1537). Sem categoria é ausência, não "". */
function readCategorias(settings: Record<string, unknown> | null): Record<string, string> {
  const saida: Record<string, string> = {};
  if (!settings) return saida;
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  if (!Array.isArray(r)) return saida;
  for (const item of r) {
    if (typeof item !== "object" || item === null) continue;
    const { label, categoria } = item as { label?: unknown; categoria?: unknown };
    if (typeof label === "string" && typeof categoria === "string" && categoria.trim()) {
      saida[label.trim()] = categoria.trim();
    }
  }
  return saida;
}


function readWonReasons(settings: Record<string, unknown> | null): string[] {
  const r = (settings as { won_reasons?: unknown } | null)?.won_reasons;
  return Array.isArray(r) ? r.filter((v): v is string => typeof v === "string") : [];
}
export function PipelinesClient({
  pipelines,
  etapas = {},
  podeEditarConfig,
  comandaDisponivel = false,
}: {
  pipelines: PipelineRow[];
  /**
   * As etapas de cada funil por id de funil — o que o editor de `obrigatorio_em`
   * oferece como "exigir ao entrar aqui". Opcional só para os testes que não
   * exercitam esta regra; a página sempre manda.
   */
  etapas?: Record<string, EtapaDoFunil[]>;
  /** Vocabulário/custom fields são admin (a server action recusa o resto). */
  podeEditarConfig: boolean;
  /**
   * O módulo `financeiro` está instalado (#1907)? Sem ele não existe comanda, e o
   * interruptor "abrir comanda ao ganhar" some. Ausente = desligado (falha
   * fechada); a página sempre manda.
   */
  comandaDisponivel?: boolean;
}) {
  const t = useT();
  if (pipelines.length === 0) {
    // ⚠️ NÃO PROMETA UM CAMINHO QUE NÃO EXISTE. Criar funil não é feito por
    // nenhuma tela, rota ou action deste produto — só por script de instalação;
    // e como o instalador não provisiona funil, ESTE é o estado de toda
    // instalação nova. O texto anterior mandava "crie um no quadro", e o quadro
    // vazio manda "Ir para Configurações": pingue-pongue fechado, com o usuário
    // procurando um botão que não existe em lugar nenhum.
    return (
      <Card className="p-6 text-sm leading-relaxed text-muted-foreground">
        {t("Você ainda não tem nenhum funil. Enquanto for assim, o agente atende normalmente, mas não tem para onde levar o card de ninguém — não há etapas para onde mover. Criar o funil é feito por quem instalou o sistema, direto no banco; depois ele aparece aqui para você escolher a etapa de cada passo.")}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pipelines.map((p) => (
        <Card key={p.id} className="space-y-6 p-6">
          <header>
            <h2 className="text-base font-semibold">{p.name}</h2>
            <p className="text-xs text-muted-foreground">/{p.slug}</p>
          </header>
          {/* As ETAPAS vêm primeiro, e a ordem é a do raciocínio de quem
              configura: primeiro o quadro existe do jeito da sua operação,
              depois se decide o que o assistente faz com ele. Invertido, a
              primeira coisa que o dono da clínica vê é um mapeamento sobre
              colunas de e-commerce que ele nem sabia que dava para trocar. */}
          <StagesSection pipelineId={p.id} ancoraMapeamento={ancoraDoMapeamento(p.id)} />
          <div className="border-t border-border pt-6">
            <AgentMappingSection pipelineId={p.id} ancoraEtapas={ancoraDasEtapas(p.id)} />
          </div>
          {podeEditarConfig && (
            <PipelineEditor
              pipeline={p}
              etapas={etapas[p.id] ?? []}
              comandaDisponivel={comandaDisponivel}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

function PipelineEditor({
  pipeline,
  etapas: _etapas,
  comandaDisponivel,
}: {
  pipeline: PipelineRow;
  etapas: EtapaDoFunil[];
  comandaDisponivel: boolean;
}) {
  const t = useT();
  const v = pipeline.vocabulary ?? {};
  const [lead, setLead] = useState(v.lead ?? "Lead");
  const [deal, setDeal] = useState(v.deal ?? "Deal");
  const [won, setWon] = useState(v.won ?? "Ganho");
  const [lost, setLost] = useState(v.lost ?? "Perdido");
  const [reasonsText, setReasonsText] = useState(readLostReasons(pipeline.settings).join(", "));
  const [wonReasonsText, setWonReasonsText] = useState(readWonReasons(pipeline.settings).join(", "));
  const [categorias, setCategorias] = useState<Record<string, string>>(() =>
    readCategorias(pipeline.settings),
  );
  const [wonRequired, setWonRequired] = useState(
    (pipeline.settings as { won_reason_required?: unknown } | null)?.won_reason_required === true,
  );
  // A comanda do ganho (#1477): opt-in, e o PADRÃO é a chave ausente — só o
  // `true` explícito liga. Ausência aqui renderiza desmarcado, que é o mesmo
  // que o consumidor de `lead.won` lê no banco.
  const [comandaNoGanho, setComandaNoGanho] = useState(
    (pipeline.settings as { comanda_no_ganho?: unknown } | null)?.comanda_no_ganho === true,
  );
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const reasons = reasonsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // #1537: motivo com categoria vira `{ label, categoria }`; sem categoria
    // continua string pura — formato que todo funil já tem e que o trigger
    // aceita igual.
    const motivosComCategoria = reasons.map((rotulo) => {
      const categoria = categorias[rotulo];
      return categoria ? { label: rotulo, categoria } : rotulo;
    });

    const wonReasons = wonReasonsText
      .split(",")
      .map((s2) => s2.trim())
      .filter((s2) => s2.length > 0);

    const patch: PipelineConfigPatch = {
      vocabulary: { lead, deal, won, lost },
      lost_reasons: motivosComCategoria,
      won_reasons: wonReasons,
      won_reason_required: wonRequired,
      comanda_no_ganho: comandaNoGanho,
    };
    startTransition(async () => {
      const r = await updatePipelineConfig(pipeline.id, patch);
      if (r.ok) toast.success(`${pipeline.name} ${t("atualizado.")}`);
      else toast.error(`${t("Erro:")} ${r.error}`);
    });
  }


  const motivosDaCaixa = reasonsText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <h3 className="text-sm font-semibold">{t("Vocabulário e campos")}</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">Lead</Label>
          <Input value={lead} onChange={(e) => setLead(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Deal</Label>
          <Input value={deal} onChange={(e) => setDeal(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Won</Label>
          <Input value={won} onChange={(e) => setWon(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Lost</Label>
          <Input value={lost} onChange={(e) => setLost(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de perda (separados por vírgula)")}</Label>
        <Input value={reasonsText} onChange={(e) => setReasonsText(e.target.value)} />
        {/*
          #1537 — a categoria de CADA motivo, não um campo só: é ela que o
          relatório "Perdas" e o filtro do quadro agrupam. Só aparece para
          motivo já escrito na caixa de cima: a lista continua sendo texto e a
          ordem continua sendo a do texto; o que muda é que cada item ganhou
          um campo. `__sem__` porque o Select recusa value="".
        */}
        {motivosDaCaixa.map((motivo) => {
          const opcoes = [
            ...new Set([
              ...CATEGORIAS_DE_PERDA,
              ...(categorias[motivo] ? [categorias[motivo]] : []),
            ]),
          ];
          return (
            <div key={motivo} className="flex items-center gap-2">
              <span className="w-56 truncate text-xs text-muted-foreground">{motivo}</span>
              <Select
                value={categorias[motivo] ?? "__sem__"}
                onValueChange={(valor) =>
                  setCategorias((atual) => {
                    const proximo = { ...atual };
                    if (valor === "__sem__") delete proximo[motivo];
                    else proximo[motivo] = valor;
                    return proximo;
                  })
                }
              >
                <SelectTrigger className="h-8 w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__sem__">{t("Sem categoria")}</SelectItem>
                  {opcoes.map((categoria) => (
                    <SelectItem key={categoria} value={categoria}>
                      {categoria}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de ganho (separados por vírgula)")}</Label>
        <Input value={wonReasonsText} onChange={(e) => setWonReasonsText(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {t(
            "Sem motivos cadastrados o motivo de ganho é texto livre. Com a lista, só o que está nela é aceito.",
          )}
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={wonRequired}
            onChange={(e) => setWonRequired(e.target.checked)}
          />
          {t("Exigir motivo de ganho ao fechar como ganho")}
        </label>
      </div>

      {/* ─── A COMANDA DO GANHO (#1477) ───────────────────────────────
          Porta do consumidor de `lead.won`. Desligada por padrão, pela régua
          de `docs/doctrine/extensoes.md`: quem não ativar continua com a
          operação inteira, e em loja com checkout o valor do negócio não é
          conta a receber. Sem o módulo `financeiro` instalado (#1907) não
          há comanda, e o interruptor some; o valor salvo no funil fica como
          está, e o consumidor também confere o módulo. */}
      {comandaDisponivel && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={comandaNoGanho}
              onChange={(e) => setComandaNoGanho(e.target.checked)}
            />
            {t("Abrir comanda ao ganhar um negócio neste funil")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Desligado, ganhar não mexe no financeiro: loja com checkout, infoproduto e imobiliária não vivem de conta a receber. Ligado, o arrasto para a etapa de ganho e o botão Ganhar abrem uma comanda com o valor e o contato do negócio.",
            )}
          </p>
        </div>
      )}

      {/* Os campos saíram daqui: são um cadastro da EMPRESA (lead e contato),
          com visibilidade por funil/etapa, em CRM › Campos personalizados. */}
      <div className="space-y-1 rounded-md border border-border p-3">
        <Label className="text-xs">{t("Campos do lead neste funil")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("Os campos personalizados agora são da empresa: escolha em quais funis e etapas cada um aparece.")}{" "}
          <Link href="/app/crm/campos" className="underline">{t("Abrir Campos personalizados")}</Link>
        </p>
      </div>

      <div className="flex sm:justify-end">
        <Button onClick={handleSave} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("Salvando…") : t("Salvar vocabulário e campos")}
        </Button>
      </div>
    </div>
  );
}
