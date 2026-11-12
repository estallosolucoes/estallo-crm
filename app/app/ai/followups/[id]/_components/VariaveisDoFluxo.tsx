"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { format } from "date-fns";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { previaDoTexto, saidasDosPassos } from "@/lib/followup/previa-do-texto";
import { useFollowupEnrollment } from "@/hooks/followup/useFollowupEnrollment";
import { useFollowupQueue } from "@/hooks/followup/useFollowupQueue";
import { ancestrais, camposDeSaidaDoNo } from "@/lib/followup/variaveis-de-blocos";
import { useT } from "@/hooks/i18n/useT";

/** O fluxo como está AGORA no construtor e qual bloco está aberto no painel — é o que define as variáveis disponíveis. */
interface Estado {
  grafo: Pick<FlowGraph, "nodes" | "edges"> | null;
  noId: string | null;
  /** Com o fluxo, a prévia oferece execuções reais dele como amostra. */
  flowId?: string;
}

interface Contextual extends Estado {
  /** A execução escolhida como amostra da prévia (`null` = exemplo simulado). Vale para todos os blocos do editor. */
  amostra: string | null;
  setAmostra: (id: string | null) => void;
}

const Contexto = createContext<Contextual>({ grafo: null, noId: null, amostra: null, setAmostra: () => {} });

export function VariaveisDoFluxoProvider({ grafo, noId, flowId, children }: Estado & { children: ReactNode }) {
  const [amostra, setAmostra] = useState<string | null>(null);
  const valor = useMemo(
    () => ({ grafo, noId, ...(flowId ? { flowId } : {}), amostra, setAmostra }),
    [grafo, noId, flowId, amostra],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export interface VariavelOferecida {
  /** O que entra no texto. */
  marca: string;
  rotulo: string;
}
export interface GrupoDeVariaveis {
  rotulo: string;
  itens: VariavelOferecida[];
}

/** Os dados de quem recebe: valem em qualquer bloco, sem depender do caminho. */
const DO_CONTATO: VariavelOferecida[] = [
  { marca: "{{nome}}", rotulo: "Nome" },
  { marca: "{{primeiro_nome}}", rotulo: "Primeiro nome" },
  { marca: "{{telefone}}", rotulo: "Telefone" },
  { marca: "{{email}}", rotulo: "E-mail" },
  { marca: "{{lead.title}}", rotulo: "Título do negócio" },
];

/**
 * As variáveis que o bloco aberto pode usar: os dados do contato e, de cada bloco que vem ANTES dele no caminho, os
 * campos de saída que o bloco declara. O nome mostrado é o que a pessoa deu ao bloco; a marca leva o id (estável).
 */
export function gruposDeVariaveis(
  grafo: Estado["grafo"],
  noId: string | null,
  soBlocos = false,
): GrupoDeVariaveis[] {
  const grupos: GrupoDeVariaveis[] = soBlocos ? [] : [{ rotulo: "Contato e negócio", itens: DO_CONTATO }];
  if (!grafo || !noId) return grupos;
  const anteriores = ancestrais(grafo, noId);
  for (const no of grafo.nodes) {
    if (!anteriores.has(no.id)) continue;
    const campos = camposDeSaidaDoNo(no);
    if (campos.length === 0) continue;
    grupos.push({
      rotulo: no.label,
      itens: campos.map((c) => ({ marca: `{{nodes.${no.id}.${c.caminho}}}`, rotulo: c.rotulo })),
    });
  }
  return grupos;
}

/**
 * "Inserir variável": lista os dados do contato e as saídas dos blocos anteriores, e devolve a marca pronta.
 * Quem usa decide ONDE ela entra no texto (no cursor).
 */
export function InserirVariavel({
  onInserir,
  soBlocos = false,
}: {
  onInserir: (marca: string) => void;
  /** Só as saídas dos blocos anteriores (o Mapear dados não lê os dados do contato pela marca). */
  soBlocos?: boolean;
}) {
  const t = useT();
  const { grafo, noId } = useContext(Contexto);
  const grupos = useMemo(() => gruposDeVariaveis(grafo, noId, soBlocos), [grafo, noId, soBlocos]);

  return (
    // `value=""` mantém o seletor sempre em "Inserir variável": ele é um menu de ações, não um campo com valor.
    <Select value="" onValueChange={(marca) => marca && onInserir(marca)}>
      <SelectTrigger aria-label={t("Inserir variável")} className="h-8 w-auto gap-1 text-xs" data-testid="inserir-variavel">
        <SelectValue placeholder={t("Inserir variável")} />
      </SelectTrigger>
      <SelectContent>
        {grupos.map((g) => (
          <SelectGroup key={g.rotulo}>
            <SelectLabel>{t(g.rotulo)}</SelectLabel>
            {g.itens.map((i) => (
              <SelectItem key={i.marca} value={i.marca}>
                {t(i.rotulo)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Insere `marca` no cursor de um campo de texto (ou no fim, sem foco) e devolve o texto novo. */
export function inserirNoCursor(campo: HTMLTextAreaElement | HTMLInputElement | null, texto: string, marca: string): string {
  const inicio = campo?.selectionStart ?? texto.length;
  const fim = campo?.selectionEnd ?? texto.length;
  return texto.slice(0, inicio) + marca + texto.slice(fim);
}

/**
 * «Como vai sair»: o texto com uma amostra EXPLÍCITA (contato e saídas de exemplo). Não é dado de cliente nem de
 * execução — o rótulo diz isso. Só aparece quando o texto tem variável: sem ela a prévia seria o próprio campo.
 */
export function PreviaDoTexto({ texto }: { texto: string }) {
  const { flowId, amostra } = useContext(Contexto);
  if (!/\{\{[^}]+\}\}/.test(texto)) return null;
  if (!flowId) return <CorpoDaPrevia texto={texto} />;
  return (
    <div className="space-y-1">
      <EscolherAmostra flowId={flowId} />
      {amostra ? <PreviaComExecucao texto={texto} execucaoId={amostra} /> : <CorpoDaPrevia texto={texto} />}
    </div>
  );
}

/** «Amostra»: o exemplo simulado ou uma das execuções recentes DESTE fluxo — escolha explícita, nunca automática. */
function EscolherAmostra({ flowId }: { flowId: string }) {
  const t = useT();
  const { amostra, setAmostra } = useContext(Contexto);
  const fila = useFollowupQueue({ pointer_id: flowId });
  const execucoes = (fila.data?.pages[0]?.data ?? []).filter((l) => l.source === "enrollment").slice(0, 10);
  return (
    <Select value={amostra ?? "exemplo"} onValueChange={(v) => setAmostra(v === "exemplo" ? null : v)}>
      <SelectTrigger aria-label={t("Amostra da prévia")} className="h-8 text-xs" data-testid="amostra-da-previa">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="exemplo">{t("Exemplo simulado")}</SelectItem>
        {execucoes.map((e) => (
          <SelectItem key={e.id} value={e.id}>
            {e.contact.name}
            {e.started_at ? ` · ${format(new Date(e.started_at), "dd/MM HH:mm")}` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A prévia com as saídas REAIS da execução escolhida (sempre só dos blocos anteriores ao aberto). */
function PreviaComExecucao({ texto, execucaoId }: { texto: string; execucaoId: string }) {
  const t = useT();
  const dossie = useFollowupEnrollment(execucaoId);
  const saidas = useMemo(() => (dossie.data ? saidasDosPassos(dossie.data.passos) : null), [dossie.data]);
  if (!saidas) return <p className="text-xs text-text-muted">{t("Carregando...")}</p>;
  return <CorpoDaPrevia texto={texto} saidasReais={saidas} />;
}

function CorpoDaPrevia({ texto, saidasReais }: { texto: string; saidasReais?: Record<string, unknown> }) {
  const t = useT();
  const { grafo, noId } = useContext(Contexto);
  const previa = useMemo(() => previaDoTexto(texto, grafo, noId, saidasReais), [texto, grafo, noId, saidasReais]);
  return (
    <div className="rounded-sm border border-dashed border-border p-2 text-xs" data-testid="previa-do-texto">
      <p className="mb-1 font-medium text-text-muted">
        {saidasReais
          ? t("Como vai sair (saídas da execução escolhida; contato de exemplo)")
          : t("Como vai sair (exemplo simulado)")}
      </p>
      <p className="whitespace-pre-wrap">{previa.texto}</p>
      {previa.sem_valor.length > 0 && (
        <p className="mt-1 text-warning-fg" data-testid="previa-sem-valor">
          {saidasReais ? t("Ficaria sem valor nesta execução:") : t("Ficaria sem valor com este exemplo:")}{" "}
          {previa.sem_valor.join(", ")}
        </p>
      )}
    </div>
  );
}

/**
 * «Aplicar em» (Fase 5): o negócio ou o contato que um Buscar ou criar ANTERIOR entregou. Só oferece blocos que vêm
 * antes no caminho (a publicação recusa o resto). `so="contato"` para quem precisa de um contato.
 */
export function AlvoDoBloco({
  valor,
  onChange,
  so,
  id,
}: {
  valor: string;
  onChange: (marca: string) => void;
  so?: "contato";
  id: string;
}) {
  const t = useT();
  const { grafo, noId } = useContext(Contexto);
  const opcoes = useMemo(() => {
    if (!grafo || !noId) return [];
    const antes = ancestrais(grafo, noId);
    return grafo.nodes
      .filter((n) => antes.has(n.id) && (n.type === "find_or_create_lead" || n.type === "find_or_create_contact"))
      .flatMap((n) => [
        ...(n.type === "find_or_create_lead" && so !== "contato"
          ? [{ marca: `{{nodes.${n.id}.lead_id}}`, rotulo: n.label, negocio: true }]
          : []),
        { marca: `{{nodes.${n.id}.contact_id}}`, rotulo: n.label, negocio: false },
      ]);
  }, [grafo, noId, so]);
  return (
    <Select value={valor || "__execucao"} onValueChange={(v) => onChange(v === "__execucao" ? "" : v)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__execucao">
          {so === "contato" ? t("O contato desta execução") : t("O negócio e o contato desta execução")}
        </SelectItem>
        {opcoes.map((o) => (
          <SelectItem key={o.marca} value={o.marca}>
            {o.negocio ? t("Negócio de") : t("Contato de")} «{o.rotulo}»
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
