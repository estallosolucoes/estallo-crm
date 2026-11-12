"use client";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCatalogoDeProdutos } from "@/hooks/leads/useProdutosDoNegocio";
import { useQueryClient } from "@tanstack/react-query";
import { SeletorDeTags } from "@/components/tags/SeletorDeTags";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { totalDoItem } from "@/lib/schemas/produtos-do-negocio";
import { apiClient } from "@/lib/api/client";
import { X } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CampoDeDinheiro } from "@/components/ui/campo-de-dinheiro";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import type { RespostaCriacaoDeLead } from "@/hooks/kanban/useCreateLead";
import type { Stage } from "@/lib/kanban/types";
import {
  AVISO_NEGOCIO_ABERTO_EXISTENTE,
  negocioAbertoNoQuadro,
  type NegocioAbertoExistente,
} from "@/lib/leads/negocio-aberto-duplicado";
import type { Lead } from "@/lib/types/leads";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";
import {
  MOEDA_PADRAO,
  centavosParaCampo,
  formatCents,
  parseReaisToCents,
  simboloDaMoeda,
} from "@/lib/money";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { SeletorDeContato } from "./SeletorDeContato";

interface FormShape {
  title: string;
  description: string;
  stage_id: string;
  valueReais: string;
  expected_close_date: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  initialStageId?: string;
  /** Vincula o lead criado a este contato de origem (ex.: painel do Inbox). */
  contactId?: string | null;
  /** Depois do INSERT — o inbox relê o resumo para o lead novo aparecer no formulário. */
  onCreated?: () => void;
  /**
   * Negócios do funil, para a pergunta de duplicidade ANTES de criar (#1751).
   *
   * É o quadro que a página de funil já tem em mãos — sem rede, sem atraso no
   * clique. Quem abre pelo Inbox recebe só o `contactId` e não tem esta lista:
   * ali a conferência prévia não acontece, e quem avisa é a `meta.avisos` da
   * resposta (o fallback aqui embaixo). Mesmo funil é filtrado DUAS vezes —
   * aqui e em `negocioAbertoNoQuadro` — porque a duplicidade é mesmo contato +
   * mesmo funil + aberto, e depender de quem chama é como a regra se perde.
   */
  leads?: Lead[];
}

/** Produto escolhido antes de o negócio existir: gravado depois do INSERT. */
interface ProdutoEscolhido {
  product_id: string;
  desconto_cents: number;
}

/** O "ninguém" no Select de responsável — o Radix não aceita item de valor vazio. */
const SEM_RESPONSAVEL = "__sem_responsavel__";

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

export function NewLeadDialog({
  open,
  onOpenChange,
  pipelineId,
  stages,
  initialStageId,
  contactId,
  leads,
  onCreated,
}: Props) {
  const t = useT();
  const org = useActiveOrg();
  // Negócio NOVO nasce na moeda da organização (createLeadHandler).
  const moedaDoValor = org?.currency ?? MOEDA_PADRAO;
  const create = useCreateLead(pipelineId);
  const initialStage = useMemo(
    () => (stages.some((s) => s.id === initialStageId) ? initialStageId! : defaultStageId(stages)),
    [stages, initialStageId],
  );
  // Quem abre o diálogo já sabendo o contato (Inbox) não escolhe de novo.
  const [contato, setContato] = useState<Contact | null>(null);
  // O RESPONSÁVEL nasce como quem está criando, e pode ser trocado (ou tirado).
  // Os destinos são os mesmos da transferência: membros ativos agent+.
  const usuario = useUser();
  const [responsavel, setResponsavel] = useState<string>(usuario.id);
  const { data: membrosBrutos } = useAssignableMembers(open);
  const membros = Array.isArray(membrosBrutos) ? membrosBrutos : [];
  // PRODUTOS: escolhidos aqui, gravados depois do INSERT pela mesma rota do
  // dossiê (`/leads/[id]/produtos`) — o valor do negócio passa a ser a soma
  // deles, pela trigger do banco, igual a adicionar pelo card.
  const { data: catalogoBruto } = useCatalogoDeProdutos(open);
  const catalogo = Array.isArray(catalogoBruto) ? catalogoBruto : undefined;
  const [produtos, setProdutos] = useState<ProdutoEscolhido[]>([]);
  // Etiquetas de OPORTUNIDADE: o mesmo seletor do dossiê (cadastradas + criar).
  const [tags, setTags] = useState<string[]>([]);
  const qc = useQueryClient();
  // Com produtos, o valor É a soma deles (já com os descontos) — a mesma conta
  // da trigger, mostrada na hora em que o produto entra.
  const somaDosProdutos = produtos.reduce((soma, escolhido) => {
    const p = catalogo?.find((c) => c.id === escolhido.product_id);
    if (!p) return soma;
    return (
      soma +
      totalDoItem({
        quantidade: 1,
        preco_unitario_cents: p.preco_cents,
        desconto_cents: escolhido.desconto_cents,
      })
    );
  }, 0);
  // ─── O AVISO DE NEGÓCIO ABERTO DUPLICADO (issue #1751) ─────────────────────
  //
  // Guarda TAMBÉM os valores do formulário: quem chega aqui já preencheu tudo,
  // e confirmar tem de criar sem pedir para digitar de novo. `null` = não há
  // nada pendente. Declarado ANTES do bloco de reset abaixo, que o limpa —
  // use-before-declaration em render é ReferenceError, não linter.
  const [aviso, setAviso] = useState<{
    existente: NegocioAbertoExistente;
    valores: FormShape;
  } | null>(null);

  // O contato é o único campo deste diálogo que cria VÍNCULO, e o componente
  // NÃO desmonta ao fechar: o funil o mantém montado enquanto há dados
  // (`app/app/pipelines/[id]/_client.tsx`). Sem esquecê-lo, quem escolheu um
  // contato, desistiu e fechou reabre com ele ainda selecionado — e o próximo
  // negócio nasce ligado a quem o operador desistiu de usar, sem nada na tela
  // dizendo. A limpeza é feita no RENDER, comparando com o valor anterior, e
  // não em `onOpenChange`: o botão "Cancelar" chama o `onOpenChange` do PAI
  // direto, então um wrapper aqui não cobriria esse caminho. É o padrão que o
  // React documenta para ajustar estado quando uma prop muda — sem efeito, e
  // portanto sem o aviso de `react-hooks/set-state-in-effect`.
  const [estavaAberto, setEstavaAberto] = useState(open);
  if (open !== estavaAberto) {
    setEstavaAberto(open);
    // O aviso morre junto com o diálogo: reabrir para um contato novo não pode
    // reapresentar a pendência de quem desistiu no meio.
    if (!open) {
      setContato(null);
      setAviso(null);
      setResponsavel(usuario.id);
      setProdutos([]);
      setTags([]);
    }
  }

  const form = useForm<FormShape>({
    defaultValues: {
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      expected_close_date: "",
    },
  });

  // Reset stage_id default if stages change while dialog mounted.
  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

  /**
   * O submit normal. ANTES de qualquer chamada de rede vem a pergunta de
   * duplicidade (#1751) — se já houver um negócio aberto deste contato NESTE
   * funil, o diálogo para aqui com o link na mão e nada é criado. Quem decide
   * se o segundo nasce é a pessoa, não o banco: a 0256 proíbe o bloqueio.
   */
  async function onSubmit(values: FormShape) {
    const idDoContato = contactId ?? contato?.id ?? null;
    const existente = negocioAbertoNoQuadro(leads ?? [], {
      pipelineId,
      contactId: idDoContato,
    });
    if (existente) {
      setAviso({ existente, valores: values });
      return;
    }
    await gravar(values, false);
  }

  /** Quem confirmou o aviso: cria sem perguntar de novo (a pergunta já foi). */
  async function confirmarAviso() {
    if (!aviso) return;
    const { valores } = aviso;
    setAviso(null);
    await gravar(valores, true);
  }

  /**
   * A criação de fato. `avisoJaMostrado` é quem sabe se a pessoa JÁ viu a
   * duplicidade — é a única forma de não dizer a mesma coisa duas vezes.
   */
  async function gravar(values: FormShape, avisoJaMostrado: boolean) {
    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    // Com produtos, o valor sai da soma (trigger): o campo nem é enviado.
    if (reais.length > 0 && produtos.length === 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    const payload: Record<string, unknown> = {
      pipeline_id: pipelineId,
      stage_id: values.stage_id,
      title: values.title.trim(),
      // A moeda NÃO vai daqui. O browser não sabe a moeda da organização, e
      // mandar "BRL" fazia toda instalação em peso ou dólar cadastrar lead em
      // real. Omitir é o conserto: quem decide é o servidor, que lê a
      // organização (`moedaDaOrganizacao`, em `createLeadHandler`).
      source: "manual",
      tags,
    };
    const idDoContato = contactId ?? contato?.id ?? null;
    if (idDoContato) payload.contact_id = idDoContato;
    if (values.description.trim()) payload.description = values.description.trim();
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;
    if (responsavel !== SEM_RESPONSAVEL) payload.owner_user_id = responsavel;

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      const resposta = await create.mutateAsync(parsed.data as CreateLeadInput);
      // ─── O AVISO QUE CHEGA JUNTO COM A RESPOSTA (#1751) ────────────────────
      //
      // É o caminho em que NÃO dá para perguntar antes: o diálogo aberto pelo
      // Inbox recebe só o `contactId`, sem a lista de negócios do funil. A API
      // avisa sem recusar (a 0256 proíbe o bloqueio), e a tela traduz esse
      // `meta.avisos` no mesmo link do aviso prévio — nunca em silêncio.
      //
      // `avisoJaMostrado` evita a segunda chamada de quem já confirmou o aviso
      // no diálogo: a mesma duplicidade contada duas vezes ensina a ignorar.
      const meta = (resposta as RespostaCriacaoDeLead | null | undefined)?.meta;
      const leadId = (resposta as RespostaCriacaoDeLead | null | undefined)?.data?.id;
      // O negócio JÁ existe: falha num produto não desfaz nada nem vira erro de
      // criação — diz quantos não entraram, e o resto se completa pelo card.
      if (leadId && produtos.length > 0) {
        const falhas = (
          await Promise.allSettled(
            produtos.map(({ product_id, desconto_cents }) =>
              apiClient.post(`/api/v1/leads/${leadId}/produtos`, { product_id, desconto_cents }),
            ),
          )
        ).filter((r) => r.status === "rejected").length;
        // O quadro foi relido na criação, ANTES de os produtos mudarem o valor.
        void qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
        if (falhas > 0) {
          toast.warning(t("Lead criado, mas alguns produtos não foram adicionados."));
        }
      }
      const avisos = meta?.avisos ?? [];
      if (!avisoJaMostrado && avisos.includes(AVISO_NEGOCIO_ABERTO_EXISTENTE)) {
        const existente = meta?.negocio_aberto_existente;
        toast.warning(t("Este contato já tem um negócio aberto neste funil."), {
          description: existente ? (
            <a
              href={`/app/pipelines/${pipelineId}?lead=${existente.id}`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {existente.title}
            </a>
          ) : undefined,
        });
      }
      toast.success(t("Lead criado"));
      onCreated?.();
      form.reset({
        title: "",
        description: "",
        stage_id: initialStage,
        valueReais: "",
        expected_close_date: "",
      });
      setContato(null);
      setAviso(null);
      setResponsavel(usuario.id);
      setProdutos([]);
      setTags([]);
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  const stageId = form.watch("stage_id");
  // Negócio sem pessoa não tem para quem o WhatsApp falar nem com quem a
  // automação casar. Dizer isso na hora vale mais que travar: quem abre o card
  // no meio da ligação e completa depois continua conseguindo, e a importação e
  // as automações seguem criando sem contato de propósito.
  const faltaContato = !contactId && !contato;

  function escolherContato(escolhido: Contact | null) {
    setContato(escolhido);
    if (escolhido && !form.getValues("title").trim()) {
      form.setValue("title", rotuloDoContato(escolhido, t));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo Lead")}</DialogTitle>
          <DialogDescription>{t("Crie um lead manualmente neste pipeline.")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {!contactId && (
            <>
              <SeletorDeContato escolhido={contato} onEscolher={escolherContato} />
              {faltaContato && (
                <p className="text-xs text-muted-foreground">
                  {t("Sem contato, este lead não recebe WhatsApp nem entra nas automações.")}
                </p>
              )}
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">{t("Título")}</Label>
            <Input
              id="title"
              placeholder={t("Ex: Pedido Maria — combo presente")}
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t("Descrição")}</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder={t("Contexto, observações, links…")}
              {...form.register("description")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Etapa")}</Label>
            <Select value={stageId} onValueChange={(v) => form.setValue("stage_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder={t("Selecione a etapa")} />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => !s.is_archived)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("Produtos")}</Label>
            {produtos.length > 0 && (
              <ul className="space-y-2" data-testid="novo-lead-produtos">
                {produtos.map((escolhido) => (
                  <LinhaDoProdutoEscolhido
                    key={escolhido.product_id}
                    produto={catalogo?.find((c) => c.id === escolhido.product_id)}
                    escolhido={escolhido}
                    moeda={moedaDoValor}
                    onDesconto={(desconto_cents) =>
                      setProdutos((atual) =>
                        atual.map((x) =>
                          x.product_id === escolhido.product_id ? { ...x, desconto_cents } : x,
                        ),
                      )
                    }
                    onRemover={() =>
                      setProdutos((atual) =>
                        atual.filter((x) => x.product_id !== escolhido.product_id),
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {/* `value=""` mantém o seletor como AÇÃO ("adicionar"), não como
                estado: cada escolha entra na lista acima e o gatilho volta vazio. */}
            <Select
              value=""
              onValueChange={(id) =>
                setProdutos((atual) =>
                  atual.some((x) => x.product_id === id)
                    ? atual
                    : [...atual, { product_id: id, desconto_cents: 0 }],
                )
              }
              disabled={!catalogo || catalogo.length === 0}
            >
              <SelectTrigger data-testid="novo-lead-adicionar-produto">
                <SelectValue
                  placeholder={
                    catalogo && catalogo.length === 0
                      ? t("Nenhum produto no catálogo")
                      : t("Adicionar produto")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(catalogo ?? [])
                  .filter((c) => c.ativo && !produtos.some((x) => x.product_id === c.id))
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.nome} · {formatCents(c.preco_cents, moedaDoValor)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              {/* Negócio novo: o rótulo segue a moeda da organização, que é onde ele
                  vai nascer. `R$` em duro mentia para quem opera em euro. */}
              <Label htmlFor="valueReais">
                {t("Valor")} ({simboloDaMoeda(moedaDoValor)})
              </Label>
              {produtos.length > 0 ? (
                <>
                  <Input
                    id="valueReais"
                    readOnly
                    value={formatCents(somaDosProdutos, moedaDoValor)}
                    data-testid="novo-lead-valor-pelos-produtos"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("Calculado pelos produtos, já com os descontos.")}
                  </p>
                </>
              ) : (
                <>
                  {/* A máscara É o eco: o que aparece no campo é o que será gravado. */}
                  <CampoDeDinheiro
                    id="valueReais"
                    moeda={moedaDoValor}
                    {...form.register("valueReais")}
                  />
                </>
              )}
              {form.formState.errors.valueReais && (
                <p className="text-xs text-error-fg">{form.formState.errors.valueReais.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected_close_date">{t("Fechamento previsto")}</Label>
              <Input
                id="expected_close_date"
                type="date"
                {...form.register("expected_close_date")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("Tags")}</Label>
            <SeletorDeTags
              entidade="lead"
              valor={tags}
              onChange={setTags}
              rotulo={t("Tags da oportunidade")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("Responsável")}</Label>
            <Select value={responsavel} onValueChange={setResponsavel}>
              <SelectTrigger data-testid="novo-lead-responsavel">
                <SelectValue placeholder={t("Sem responsável")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_RESPONSAVEL}>{t("Sem responsável")}</SelectItem>
                {/* Quem cria aparece mesmo antes da lista chegar: é o padrão
                    selecionado, e o gatilho não pode ficar em branco. */}
                {!membros.some((m) => m.user_id === usuario.id) && (
                  <SelectItem value={usuario.id}>{usuario.full_name ?? t("Você")}</SelectItem>
                )}
                {membros.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? t("Sem nome")}
                    {m.user_id === usuario.id ? ` (${t("você")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* O AVISO SEM BLOQUEIO (#1751): aparece quando já existe negócio
              aberto deste contato NESTE funil. Ele não recusa nada — só para o
              clique e pergunta, com o link para quem já está no quadro. Recusar
              ("Não criar") fecha a pendência sem TOCAR na rede: nada é criado. */}
          {aviso && (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950"
            >
              <p className="font-medium">
                {t("Este contato já tem um negócio aberto neste funil.")}
              </p>
              <p className="mt-1">{t("Abrir mesmo assim?")}</p>
              {/* O link é o próprio título do negócio — dado do banco, não
                  texto de interface: traduzir seria mentir sobre o que a pessoa
                  vai abrir. */}
              <a
                href={`/app/pipelines/${pipelineId}?lead=${aviso.existente.id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block underline"
              >
                {aviso.existente.title}
              </a>
              <div className="mt-3 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setAviso(null)}>
                  {t("Não criar")}
                </Button>
                <Button type="button" onClick={() => void confirmarAviso()}>
                  {t("Criar mesmo assim")}
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={create.isPending || !stageId}>
              {create.isPending ? t("Criando…") : t("Criar lead")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function centsParaTexto(cents: number): string {
  return cents ? centavosParaCampo(cents) : "";
}

/** Uma linha de produto do Novo Lead, com o desconto como no dossiê (`ProdutosDoNegocio`). */
function LinhaDoProdutoEscolhido({
  produto,
  escolhido,
  moeda,
  onDesconto,
  onRemover,
}: {
  produto: { nome: string; preco_cents: number } | undefined;
  escolhido: ProdutoEscolhido;
  moeda: string;
  onDesconto: (cents: number) => void;
  onRemover: () => void;
}) {
  const t = useT();
  const [desconto, setDesconto] = useState(centsParaTexto(escolhido.desconto_cents));
  const preco = produto?.preco_cents ?? 0;

  function aplicarDesconto() {
    const texto = desconto.trim();
    const cents = texto === "" ? 0 : parseReaisToCents(texto);
    if (cents === null || cents < 0) {
      toast.error(t("Desconto inválido"));
      setDesconto(centsParaTexto(escolhido.desconto_cents));
      return;
    }
    if (cents !== escolhido.desconto_cents) onDesconto(cents);
  }

  return (
    <li className="space-y-2 rounded-md border border-border p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{produto?.nome ?? "…"}</p>
          <p className="text-xs text-muted-foreground">{formatCents(preco, moeda)}</p>
        </div>
        <button
          type="button"
          aria-label={`${t("Remover")} ${produto?.nome ?? ""}`}
          onClick={onRemover}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-text"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-2 items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`novo-lead-desconto-${escolhido.product_id}`} className="text-xs">
            {t("Desconto")}
          </Label>
          <CampoDeDinheiro
            id={`novo-lead-desconto-${escolhido.product_id}`}
            moeda={moeda}
            className="h-8"
            value={desconto}
            onChange={(e) => setDesconto(e.target.value)}
            onBlur={aplicarDesconto}
            onKeyDown={(e) => {
              // Enter aplica o desconto, não envia o formulário inteiro.
              if (e.key === "Enter") {
                e.preventDefault();
                aplicarDesconto();
              }
            }}
          />
        </div>
        <div className="space-y-1 text-right">
          <p className="text-xs text-muted-foreground">{t("Total")}</p>
          <p className="h-8 leading-8 font-medium">
            {formatCents(
              totalDoItem({
                quantidade: 1,
                preco_unitario_cents: preco,
                desconto_cents: escolhido.desconto_cents,
              }),
              moeda,
            )}
          </p>
        </div>
      </div>
    </li>
  );
}
