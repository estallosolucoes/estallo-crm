"use client";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { CampoDeDinheiro } from "@/components/ui/campo-de-dinheiro";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import {
  centavosParaCampo,
  formatCents,
  MOEDA_PADRAO,
  parseReaisToCents,
  simboloDaMoeda,
} from "@/lib/money";
import { ROLE_RANK } from "@/lib/auth/types";
import { useProdutosDoNegocio } from "@/hooks/leads/useProdutosDoNegocio";
import { totalDoItem } from "@/lib/schemas/produtos-do-negocio";
import { soChavesAlteradas } from "@/lib/leads/custom-fields-so-diff";
import { CustomFieldsEditor, type CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { SeletorDeTags } from "@/components/tags/SeletorDeTags";
import { ProdutosDoNegocio } from "./ProdutosDoNegocio";

interface Props {
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
}

/** Espera depois da última tecla num campo personalizado antes de gravar. */
const ESPERA_DOS_CAMPOS_MS = 800;

/**
 * Os campos do lead no dossiê — e cada mudança GRAVA NA HORA (30/10/2026).
 *
 * Antes a ficha era um rascunho com um "Salvar" no pé; a operação reclamou que
 * produto, tag e campo demoravam a "pegar". Agora:
 *  - data, tags e produtos gravam no clique/escolha;
 *  - título, descrição e valor gravam ao sair do campo (ou Enter);
 *  - campos personalizados gravam depois de uma pausa na digitação;
 *  - o que ficou pendente grava ao fechar a gaveta (desmontar).
 * A tela muda antes do servidor responder (`useEditLead` e
 * `useProdutosDoNegocio` são otimistas); erro desfaz o campo e mostra o motivo.
 */
export function LeadFieldsForm({ lead, pipelineId, fieldDefs: todosOsCampos = [] }: Props) {
  // Campo restrito a etapas (cadastro central, 0657) só aparece na etapa do lead.
  const fieldDefs = todosOsCampos.filter(
    (f) => !f.etapas_visiveis || f.etapas_visiveis.includes(lead.stage_id),
  );
  const t = useT();
  const org = useActiveOrg();
  // A moeda do negócio JÁ GRAVADO vence: trocar a moeda da empresa não
  // reescreve o que nasceu antes, e o cartão e o dossiê mostram a persistida.
  const moedaDoValor = lead.currency ?? org?.currency ?? MOEDA_PADRAO;
  const edit = useEditLead(pipelineId);
  const user = useUser();
  // Produtos são `agent`+, a régua da rota (e o suporte temporário só lê).
  const podeEditarProdutos =
    (user.is_platform_admin && !user.support) ||
    (org ? ROLE_RANK[org.role] >= ROLE_RANK.agent : false);
  // Com produtos, o valor do negócio é a SOMA deles (trigger da 0660): o campo
  // vira leitura e nada aqui manda `value_cents`, senão sobrescreveria a conta.
  const produtos = useProdutosDoNegocio(lead.id, pipelineId);
  const itens = produtos.data ?? [];
  const valorPelosProdutos =
    itens.length > 0 ? itens.reduce((s, i) => s + totalDoItem(i), 0) : null;

  const [titulo, setTitulo] = useState(lead.title);
  const [descricao, setDescricao] = useState(lead.description ?? "");
  const [valor, setValor] = useState(centavosParaCampo(lead.value_cents));
  const [fechamento, setFechamento] = useState(lead.expected_close_date ?? "");
  const [tags, setTags] = useState<string[]>(lead.tags ?? []);
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    lead.custom_fields ?? {},
  );
  // A RÉGUA do diff (issue #2132): só o que a pessoa mudou viaja — devolver o
  // objeto inteiro sobrescrevia o que outra pessoa (ou o MCP) mudou com a ficha
  // aberta. Avança a cada gravação.
  const camposGravados = useRef<Record<string, unknown>>(lead.custom_fields ?? {});
  const camposAtuais = useRef(customFields);
  const timerDosCampos = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Os textos que ainda não saíram do campo — gravados ao desmontar.
  const textoPendente = useRef<(() => void) | null>(null);

  // Outro negócio na mesma ficha: os campos recomeçam do gravado (ajuste no
  // render, não em efeito — evita o render em cascata).
  const [leadDaFicha, setLeadDaFicha] = useState(lead.id);
  if (leadDaFicha !== lead.id) {
    setLeadDaFicha(lead.id);
    setTitulo(lead.title);
    setDescricao(lead.description ?? "");
    setValor(centavosParaCampo(lead.value_cents));
    setFechamento(lead.expected_close_date ?? "");
    setTags(lead.tags ?? []);
    setCustomFields(lead.custom_fields ?? {});
  }
  useEffect(() => {
    camposGravados.current = lead.custom_fields ?? {};
    camposAtuais.current = lead.custom_fields ?? {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  /** Grava um pedaço do lead. `desfazer` devolve o campo se a gravação falhar. */
  function salvar(patch: Record<string, unknown>, desfazer: () => void) {
    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? t("Dados inválidos"));
      desfazer();
      return;
    }
    edit.mutate({ leadId: lead.id, patch: parsed.data as UpdateLeadInput }, { onError: desfazer });
  }

  function gravarCampos() {
    if (timerDosCampos.current) clearTimeout(timerDosCampos.current);
    timerDosCampos.current = null;
    const antes = camposGravados.current;
    const diff = soChavesAlteradas(antes, camposAtuais.current);
    if (Object.keys(diff).length === 0) return;
    camposGravados.current = { ...camposAtuais.current };
    salvar({ custom_fields: diff }, () => {
      camposGravados.current = antes;
      camposAtuais.current = antes;
      setCustomFields(antes);
    });
  }

  // Fechar a gaveta não perde o que estava sendo digitado.
  useEffect(
    () => () => {
      textoPendente.current?.();
      if (timerDosCampos.current) gravarCampos();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function gravarTitulo(bruto: string) {
    textoPendente.current = null;
    const novo = bruto.trim();
    if (novo === lead.title) return;
    const antes = lead.title;
    if (novo.length < 2) {
      toast.error(t("O título precisa de pelo menos 2 caracteres."));
      setTitulo(antes);
      return;
    }
    salvar({ title: novo }, () => setTitulo(antes));
  }

  function gravarDescricao(bruto: string) {
    textoPendente.current = null;
    const novo = bruto.trim() ? bruto.trim() : null;
    if (novo === (lead.description ?? null)) return;
    const antes = lead.description ?? "";
    salvar({ description: novo }, () => setDescricao(antes));
  }

  function gravarValor(bruto: string) {
    textoPendente.current = null;
    const texto = bruto.trim();
    const cents = texto.length > 0 ? parseReaisToCents(texto) : null;
    const antes = centavosParaCampo(lead.value_cents);
    if (texto.length > 0 && cents === null) {
      toast.error(t("Valor inválido"));
      setValor(antes);
      return;
    }
    if (cents === lead.value_cents) return;
    salvar({ value_cents: cents }, () => setValor(antes));
  }

  const enterSai = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <div className="divide-y divide-border" data-testid="ficha-do-lead">
      <Grupo>
        <div className="space-y-2">
          <Label htmlFor="title">{t("Título")}</Label>
          <Input
            id="title"
            value={titulo}
            onChange={(e) => {
              const v = e.target.value;
              setTitulo(v);
              textoPendente.current = () => gravarTitulo(v);
            }}
            onBlur={(e) => gravarTitulo(e.currentTarget.value)}
            onKeyDown={enterSai}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">{t("Descrição")}</Label>
          <Textarea
            id="description"
            rows={3}
            value={descricao}
            onChange={(e) => {
              const v = e.target.value;
              setDescricao(v);
              textoPendente.current = () => gravarDescricao(v);
            }}
            onBlur={(e) => gravarDescricao(e.currentTarget.value)}
          />
        </div>
      </Grupo>

      <Grupo
        titulo={t("Produtos e valor")}
        contagem={itens.length || undefined}
        testId="grupo-produtos"
      >
        <ProdutosDoNegocio
          itens={itens}
          moeda={moedaDoValor}
          podeEditar={podeEditarProdutos}
          onAdicionar={(item) => void produtos.adicionar(item)}
          onRemover={(id) => void produtos.remover(id)}
          onAlterar={(id, campos) => void produtos.alterar(id, campos)}
        />

        <div className="grid grid-cols-2 gap-3">
          {valorPelosProdutos !== null ? (
            <div className="space-y-2">
              <Label htmlFor="valorPelosProdutos">
                {t("Valor")} ({simboloDaMoeda(moedaDoValor)})
              </Label>
              <Input
                id="valorPelosProdutos"
                readOnly
                value={formatCents(valorPelosProdutos, moedaDoValor)}
                data-testid="valor-pelos-produtos"
              />
              <p className="text-xs text-muted-foreground">
                {t("Calculado pelos produtos, já com os descontos.")}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* O rótulo segue a moeda do NEGÓCIO (a organização é a reserva):
                `R$` em duro mentia para quem opera em euro. */}
              <Label htmlFor="valueReais">
                {t("Valor")} ({simboloDaMoeda(moedaDoValor)})
              </Label>
              {/* A máscara É o eco: o que aparece no campo é o que será gravado. */}
              <CampoDeDinheiro
                id="valueReais"
                moeda={moedaDoValor}
                value={valor}
                onChange={(e) => {
                  const v = e.target.value;
                  setValor(v);
                  textoPendente.current = () => gravarValor(v);
                }}
                onBlur={(e) => gravarValor(e.currentTarget.value)}
                onKeyDown={enterSai}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
            <Input
              id="expected_close_date"
              type="date"
              value={fechamento}
              onChange={(e) => {
                const antes = fechamento;
                setFechamento(e.target.value);
                salvar({ expected_close_date: e.target.value || null }, () => setFechamento(antes));
              }}
            />
          </div>
        </div>
      </Grupo>

      <Grupo titulo={t("Tags")} contagem={tags.length || undefined} testId="grupo-tags">
        <SeletorDeTags
          entidade="lead"
          valor={tags}
          onChange={(novas) => {
            const antes = tags;
            setTags(novas);
            salvar({ tags: novas }, () => setTags(antes));
          }}
          rotulo={t("Tags da oportunidade")}
        />
      </Grupo>

      {fieldDefs.length > 0 && (
        <Grupo titulo={t("Campos personalizados")} testId="grupo-campos">
          <CustomFieldsEditor
            fields={fieldDefs}
            value={customFields}
            onChange={(novos) => {
              setCustomFields(novos);
              camposAtuais.current = novos;
              if (timerDosCampos.current) clearTimeout(timerDosCampos.current);
              timerDosCampos.current = setTimeout(gravarCampos, ESPERA_DOS_CAMPOS_MS);
            }}
            mode="lead"
          />
        </Grupo>
      )}
    </div>
  );
}

/**
 * UM GRUPO DA FICHA. Os dados do negócio são quatro assuntos independentes
 * (identificação, produtos e valor, tags, campos personalizados); com todos no
 * mesmo `space-y` e o mesmo `<Label>`, tags e campos pareciam parte dos
 * produtos. O grupo dá a cada assunto um sobretítulo próprio e o divisor sutil
 * entre eles vem do `divide-y` do pai — sem caixa dentro da caixa do bloco.
 */
function Grupo({
  titulo,
  contagem,
  testId,
  children,
}: {
  titulo?: string;
  contagem?: number;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="space-y-3 py-4 first:pt-0 last:pb-0"
      data-testid={testId}
      aria-label={titulo}
    >
      {titulo && (
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {titulo}
          {contagem !== undefined && (
            <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 font-semibold tabular-nums">
              {contagem}
            </span>
          )}
        </h4>
      )}
      {children}
    </section>
  );
}
