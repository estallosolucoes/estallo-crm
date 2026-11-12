"use client";

import { RoteirosDoContato } from "@/components/contacts/RoteirosDoContato";
import { AcervoSearch } from "./AcervoSearch";
import { LeadEnrichment } from "./LeadEnrichment";
import type { ProspectEnrichment } from "@/lib/prospecting/schema";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tag,
  Receipt,
  ArrowRight,
  Check,
  X,
  UserCircle,
  Funnel,
  Flag,
  Brain,
  ClockCounterClockwise,
  BookOpen,
  Plus,
  DotsThree,
  Trash,
  ListChecks,
  Package,
} from "@/lib/ui/icons";
import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import { AdicionarProdutoDialog } from "@/components/kanban/AdicionarProdutoDialog";
import { useTasks } from "@/hooks/tasks/useTasks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { BlocoRecolhivel } from "@/components/ui/bloco-recolhivel";
import { ROLE_RANK } from "@/lib/auth/types";
import { useWinLead } from "@/hooks/kanban/useUpdateLead";
import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { activityLabel, actorLabel, actorShape } from "@/lib/leads/activity-vocabulary";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { useTagsDoContato } from "@/hooks/contacts/useTagsDoContato";
import { useDefaultPipeline } from "@/hooks/pipelines/useDefaultPipeline";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { LeadDossierDoFunil } from "@/components/kanban/LeadDossierDoFunil";
import { cn } from "@/lib/utils";
import { PROXIMO_PASSO_DA_MENSAGEM_NOVA } from "@/lib/atendimento/proximo-passo-padrao";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact | null;
}

interface LeadRow {
  id: string;
  title: string;
  status: string;
  value_cents: number | null;
  currency: string | null;
  updated_at: string;
  expected_close_date?: string | null;
  pipeline_id: string;
  custom_fields: Record<string, unknown> | null;
  field_defs: CustomFieldDef[];
  funil_nome: string | null;
  etapa_nome: string | null;
  stage_id?: string;
  /** As etapas ativas do funil, na ordem do quadro (rota crm-summary). */
  etapas_do_funil?: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
}

interface OrderRow {
  id: string;
  external_id: string | null;
  status: string | null;
  total_cents: number | null;
  currency: string | null;
  created_at: string;
}

interface ActivityRow {
  id: string;
  type: string;
  source_module: string;
  performed_at: string;
  payload: Record<string, unknown> | null;
  /** 0071 — o porquê legível e quem agiu. */
  reason: string | null;
  actor_kind: string | null;
  /**
   * O NOME de quem agiu. `actor_kind` responde "uma pessoa ou o agente?"; esta
   * responde "qual pessoa?" — e é a diferença entre "Transferiu a conversa ·
   * Você/time" e "Transferiu a conversa · Maria Silva", que é a pergunta que o
   * painel existe para responder. `null` é estado declarado (sem service role),
   * e aí a linha volta ao rótulo genérico.
   */
  performed_by_name?: string | null;
}

/**
 * Passo 4 do cap. 5 — a demanda no lugar onde o humano atende.
 *
 * As outras três listas contam o que já aconteceu (negócio, pedido, histórico).
 * Esta conta o que **ainda não acabou**, que é a pergunta que a pessoa do outro
 * lado está fazendo. Sem ela, o atendente encerra a conversa sem saber que a
 * demanda continua aberta e sem próximo passo — e o vazamento só reaparece
 * depois, como número numa métrica que ele não abre.
 */
interface DemandaRow {
  id: string;
  revision: number;
  aberta_em: string;
  origem: string;
  estado: string;
  proximo_passo: string | null;
  proximo_passo_em: string | null;
  prazo_em: string | null;
}

interface DesfechoDraft {
  conversationId: string;
  contactId: string;
  demandaId: string;
  revision: number;
  desfecho: string;
  salvando: boolean;
}

function EncerrarDemanda({
  draft,
  onAbrir,
  onAlterar,
  onFechar,
  onPronto,
}: {
  draft: DesfechoDraft | null;
  onAbrir: () => void;
  onAlterar: (patch: Partial<Pick<DesfechoDraft, "desfecho" | "salvando">>) => void;
  onFechar: () => void;
  onPronto: () => void;
}) {
  const t = useT();
  if (!draft)
    return (
      <Button size="sm" variant="ghost" onClick={onAbrir}>
        {t("Encerrar demanda")}
      </Button>
    );
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        onAlterar({ salvando: true });
        try {
          await apiClient.patch(`/api/v1/demandas/${draft.demandaId}`, {
            action: "encerrar",
            desfecho: draft.desfecho,
            expected_revision: draft.revision,
          });
          toast.success(t("Desfecho registrado."));
          onFechar();
          onPronto();
        } catch {
          toast.error(
            t(
              "Não foi possível encerrar. Cancele esta edição e abra novamente para revisar o desfecho.",
            ),
          );
          onPronto();
        } finally {
          onAlterar({ salvando: false });
        }
      }}
    >
      <label className="block">
        {t("Desfecho")}
        <select
          aria-label={t("Desfecho da demanda")}
          className="mt-1 w-full rounded-md border bg-background p-2"
          value={draft.desfecho}
          onChange={(e) => onAlterar({ desfecho: e.target.value })}
        >
          <option value="resolvida">{t("Resolvida")}</option>
          <option value="convertida">{t("Convertida")}</option>
          <option value="nao_procede">{t("Não procede")}</option>
          <option value="encerrada_pelo_cliente">{t("Encerrada pelo cliente")}</option>
          <option value="perdida">{t("Perdida")}</option>
          <option value="expirada_sem_resposta">{t("Expirada sem resposta")}</option>
        </select>
      </label>
      <p>
        {t(
          "Registra o resultado desta demanda. As conversas dos outros canais permanecem disponíveis.",
        )}
      </p>
      <Button size="sm" disabled={draft.salvando} type="submit">
        {t("Confirmar desfecho")}
      </Button>
      <Button size="sm" variant="ghost" type="button" disabled={draft.salvando} onClick={onFechar}>
        {t("Cancelar")}
      </Button>
    </form>
  );
}

const DESFECHO_LEGIVEL: Record<string, string> = {
  resolvida: "Resolvida",
  convertida: "Convertida",
  nao_procede: "Não procede",
  encerrada_pelo_cliente: "Encerrada pelo cliente",
  perdida: "Perdida",
  expirada_sem_resposta: "Expirada sem resposta",
};

/** Vocabulário de quem atende, não o do banco. */
const ESTADO_LEGIVEL: Record<string, string> = {
  aberta: "Aberta",
  em_atendimento: "Em atendimento",
  aguardando_cliente: "Aguardando o cliente",
};

function horasDesde(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}

/**
 * Marcar o próximo passo, no lugar onde o atendente já está.
 *
 * Fica FECHADO por padrão: a lista costuma ter mais de uma demanda, e um campo
 * de texto aberto em cada uma transformaria a seção de contexto em formulário.
 * O botão é a promessa; o campo aparece quando alguém aceita.
 *
 * Sem data de propósito nesta superfície. Obrigar hora aqui faria o atendente
 * inventar uma para se livrar do campo — e data inventada é pior que ausente,
 * porque o Radar passa a cobrar no dia errado. A rota aceita
 * `proximo_passo_em`; quem precisa de compromisso datado usa o retorno.
 */
function MarcarProximoPasso({ demandaId, onPronto }: { demandaId: string; onPronto: () => void }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    const passo = texto.trim();
    if (passo.length < 3) return;
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/demandas/${demandaId}`, { proximo_passo: passo });
      setAberto(false);
      setTexto("");
      onPronto();
    } catch {
      // Falha NÃO fecha o campo: fechar devolveria a tela ao estado de sucesso
      // e o texto se perderia sem que ninguém tivesse gravado nada.
      toast.error(t("Não consegui salvar o próximo passo. Tente de novo."));
    } finally {
      setSalvando(false);
    }
  }

  if (!aberto) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="mt-1.5 h-7 text-xs"
        data-testid="marcar-proximo-passo"
        onClick={() => setAberto(true)}
      >
        {t("Marcar próximo passo")}
      </Button>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <input
        autoFocus
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void salvar();
          if (e.key === "Escape") setAberto(false);
        }}
        maxLength={500}
        placeholder={t("O que acontece a seguir?")}
        aria-label={t("Próximo passo desta demanda")}
        data-testid="campo-proximo-passo"
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:ring-1 focus:ring-ring focus:outline-hidden"
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={salvando || texto.trim().length < 3}
          data-testid="salvar-proximo-passo"
          onClick={() => void salvar()}
        >
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAberto(false)}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const cur = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

function shortDate(iso: string, locale: Locale): string {
  return format(new Date(iso), "dd/MM/yy HH:mm", { locale: locale });
}

/**
 * O que cada seção mostra quando não tem lista para mostrar.
 *
 * Peça única porque são TRÊS seções tomando a MESMA decisão — e foi por essa
 * decisão viver repetida em três lugares que as três mentiam juntas.
 *
 * Fora do componente de propósito: declarada dentro do corpo, ela vira um tipo
 * novo a cada render e o React remonta a peça inteira. O linter reprovou, com
 * razão — e eu tinha notado o cheiro e seguido em frente.
 *
 * Erro sem saída também é beco, por isso o botão.
 */
function SemLista({
  vazio,
  erro,
  onTentarDeNovo,
}: {
  vazio: string;
  erro: boolean;
  onTentarDeNovo: () => void;
}) {
  const t = useT();
  if (!erro) return <p className="text-xs text-muted-foreground">{t(vazio)}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-error-fg">{t("Não consegui ler estes dados.")}</p>
      <Button size="sm" variant="outline" onClick={onTentarDeNovo}>
        {t("Tentar de novo")}
      </Button>
    </div>
  );
}

/**
 * Só os campos do funil, no lugar onde a conversa acontece.
 *
 * Título, valor e tags já têm casa no dossiê. Quem atende descobre o dado
 * customizado (CPF, plano, endereço) aqui — e tinha de ir no Kanban gravar.
 */
/**
 * O banco guarda `open`/`won`/`lost`; a tela mostrava a palavra crua (#943).
 *
 * ⚠️ NÃO troque "Ganho"/"Perdido" por `crm_pipelines.vocabulary` sem antes
 * mudar o que essa coluna guarda. O DEFAULT dela é o de e-commerce (`won:
 * Pago`, `lost: Cancelado`, supabase/baseline.sql) e nenhum caminho normal a
 * reescreve: o onboarding troca só as ETAPAS pelo quadro do ramo
 * (`fn_aplicar_quadro_do_onboarding` atualiza nome e slug do funil), e
 * `POST /api/v1/pipelines` não a preenche — quem escreve é só a tela Etapas do
 * funil, à mão. Lida daqui, ela faria uma clínica recém-instalada ver "Pago"
 * ao lado de "Consulta marcada". Guardado em
 * tests/unit/inbox-leads-recentes-com-funil.test.tsx.
 */
const STATUS_DO_LEAD: Record<string, string> = { open: "Aberto", won: "Ganho", lost: "Perdido" };

/** "Funil · Etapa" — sem isto dois leads de mesmo título ficam idênticos (#943). */
function ondeEstaOLead(l: LeadRow): string {
  return [l.funil_nome, l.etapa_nome].filter(Boolean).join(" · ");
}

/**
 * `line-clamp-2`, não `truncate` — e a diferença não depende de medir pixel.
 *
 * `truncate` corta numa linha só, e corte de texto some pela DIREITA: a metade
 * perdida é sempre a ETAPA, que é justamente a que diz onde o negócio está.
 * "Funil de Vendas Consultivas B2B · Proposta enviada" nesta coluna de 296px
 * viraria "Funil de Vendas Consul…" — o operador lê o funil, que ele já sabia,
 * e perde a etapa, que é o dado novo. A medida por ferramenta diria a partir de
 * QUE largura isso acontece; não muda QUAL metade morre, que é o defeito.
 *
 * Duas linhas dobram o orçamento sem mexer no texto (mesmo uso que
 * `Composer.tsx:259` e `MessageBubble.tsx:193` já fazem), e o `title` devolve a
 * frase inteira no hover para o resto — com o nome do funil cortado não há
 * outro lugar na tela onde lê-lo.
 *
 * ⚠️ NÃO medido: a largura em que a segunda linha também estoura, e o
 * comportamento em tela de celular (onde não há hover). Fica para quem rodar a
 * spec de tela com `getBoundingClientRect`.
 */
const CLASSES_DE_ONDE_ESTA = "line-clamp-2 text-muted-foreground";

const COR_DO_STATUS: Record<string, string> = {
  open: "bg-accent/10 text-accent",
  won: "bg-success/15 text-success",
  lost: "bg-destructive/10 text-destructive",
};

/**
 * Os negócios do contato, do mais recente para o mais antigo. Clicar abre o
 * MESMO dossiê do quadro (`LeadDossierDoFunil`) — lá ficam etapa, campos,
 * tarefas e histórico. Ganhar e perder ficam AQUI, no card, para fechar o
 * negócio sem abrir o dossiê (mesmas rotas /win e /lose do quadro).
 */
function LeadsRecentes({
  leads,
  contactId,
  usuarioId,
  onAbrir,
  podeFechar,
  onPerder,
  onFechado,
}: {
  leads: LeadRow[];
  /** O contato da conversa: a tarefa criada pelo card nasce presa a ele também. */
  contactId: string | null;
  /** Quem está no painel: nasce como responsável da tarefa criada pelo card. */
  usuarioId: string | undefined;
  onAbrir: (lead: LeadRow) => void;
  podeFechar: boolean;
  onPerder: (lead: LeadRow) => void;
  onFechado: () => void;
}) {
  return (
    <ul className="space-y-1.5">
      {leads.map((l) => (
        <CardDoNegocio
          key={l.id}
          lead={l}
          onAbrir={onAbrir}
          // Excluir vale para todo negócio (ganho e perdido inclusive); ganhar e
          // perder, só para o aberto. Mesmo piso de papel nos dois (agent+).
          podeExcluir={podeFechar}
          contactId={contactId}
          usuarioId={usuarioId}
          podeFechar={podeFechar && l.status === "open"}
          onPerder={onPerder}
          onFechado={onFechado}
        />
      ))}
    </ul>
  );
}

function CardDoNegocio({
  lead: l,
  contactId,
  usuarioId,
  onAbrir,
  podeExcluir,
  podeFechar,
  onPerder,
  onFechado,
}: {
  lead: LeadRow;
  contactId: string | null;
  usuarioId: string | undefined;
  onAbrir: (lead: LeadRow) => void;
  podeExcluir: boolean;
  podeFechar: boolean;
  onPerder: (lead: LeadRow) => void;
  onFechado: () => void;
}) {
  const t = useT();
  // `useWinLead` é por funil, e cada negócio da lista pode estar num funil.
  const ganhar = useWinLead(l.pipeline_id);
  // Excluir é a MESMA ação do card do quadro (`KanbanCardActions`): rota em
  // lote com um id só — mesmo gate de papel, mesma RLS, mesma auditoria.
  const excluir = useBulkAction(l.pipeline_id);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  // "Criar tarefa": o MESMO formulário da tela de Tarefas e do dossiê, já preso
  // ao negócio e ao contato, com quem cria como responsável. A lista não é
  // buscada (`enabled: false`) — o card só precisa da criação.
  const { criarTarefa } = useTasks({ lead_id: l.id }, { enabled: false });
  const [criandoTarefa, setCriandoTarefa] = useState(false);
  // Chave de remontagem: cada abertura começa com o formulário limpo.
  const [aberturasDaTarefa, setAberturasDaTarefa] = useState(0);
  const [adicionandoProduto, setAdicionandoProduto] = useState(false);
  return (
    <li className="flex items-stretch overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-accent/60">
      <button
        type="button"
        data-testid={`inbox-lead-${l.id}`}
        onClick={() => onAbrir(l)}
        className="min-w-0 flex-1 p-2.5 text-left text-xs hover:bg-accent/5"
      >
        <div className="truncate text-[13px] font-medium text-text">{l.title}</div>
        <div className={CLASSES_DE_ONDE_ESTA} title={ondeEstaOLead(l)}>
          {ondeEstaOLead(l)}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              COR_DO_STATUS[l.status] ?? "bg-muted text-muted-foreground",
            )}
          >
            {t(STATUS_DO_LEAD[l.status] ?? l.status)}
          </span>
          <span className="font-medium text-text tabular-nums">
            {formatMoney(l.value_cents, l.currency)}
          </span>
        </div>
      </button>
      {(podeExcluir || podeFechar) && (
        <div className="flex flex-col items-center justify-start gap-1 border-l border-border px-1.5 py-1.5">
          {podeExcluir && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("Ações do lead")}
                  title={t("Ações do lead")}
                  data-testid={`inbox-lead-acoes-${l.id}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent/10 hover:text-text data-[state=open]:bg-accent/10 data-[state=open]:text-accent"
                >
                  <DotsThree size={16} weight="bold" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t("Ações do lead")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid={`inbox-lead-criar-tarefa-${l.id}`}
                  onSelect={() => {
                    setAberturasDaTarefa((n) => n + 1);
                    setCriandoTarefa(true);
                  }}
                >
                  <ListChecks size={15} className="mr-2" aria-hidden />
                  {t("Criar tarefa")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid={`inbox-lead-adicionar-produto-${l.id}`}
                  onSelect={() => setAdicionandoProduto(true)}
                >
                  <Package size={15} className="mr-2" aria-hidden />
                  {t("Adicionar produto")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid={`inbox-lead-excluir-${l.id}`}
                  disabled={excluir.isPending}
                  onSelect={() => setConfirmandoExclusao(true)}
                  className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash size={15} className="mr-2" aria-hidden />
                  {t("Excluir lead")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {podeFechar && (
            <>
              <button
                type="button"
                aria-label={t("Marcar como ganho")}
                title={t("Marcar como ganho")}
                data-testid={`inbox-lead-ganhar-${l.id}`}
                disabled={ganhar.isPending}
                onClick={() => ganhar.mutate({ leadId: l.id }, { onSuccess: onFechado })}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-success/15 hover:text-success disabled:opacity-50"
              >
                <Check size={15} weight="bold" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={t("Marcar como perdido")}
                title={t("Marcar como perdido")}
                data-testid={`inbox-lead-perder-${l.id}`}
                onClick={() => onPerder(l)}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X size={15} weight="bold" aria-hidden />
              </button>
            </>
          )}
        </div>
      )}
      {/* Montado só aberto, como a tarefa: cada card teria a sua consulta. */}
      {adicionandoProduto && (
        <AdicionarProdutoDialog
          aberto={adicionandoProduto}
          aoMudarAbertura={setAdicionandoProduto}
          lead={l}
          aoAdicionar={onFechado}
        />
      )}
      {/* Montado só aberto: cada card da lista teria a sua consulta da equipe. */}
      {criandoTarefa && (
        <FormularioDeTarefa
          key={aberturasDaTarefa}
          aberto={criandoTarefa}
          aoMudarAbertura={setCriandoTarefa}
          aoSalvar={async (entrada) => {
            await criarTarefa(entrada);
            toast.success(t("Tarefa criada"));
          }}
          leadId={l.id}
          contactId={contactId}
          responsavelPadrao={usuarioId ?? null}
          tituloDoNegocio={l.title}
        />
      )}
      {/*
        `AlertDialog`, e não `Dialog`: excluir é irreversível, e o padrão de
        `docs/doctrine/destrutivo-pede-confirmacao.md` é a janela que não fecha
        por clique fora.
      */}
      <AlertDialog open={confirmandoExclusao} onOpenChange={setConfirmandoExclusao}>
        <AlertDialogContent data-testid="inbox-lead-excluir-confirmacao">
          <AlertDialogHeader>
            <span
              aria-hidden
              className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive"
            >
              <Trash size={22} />
            </span>
            <AlertDialogTitle>{t("Excluir lead?")}</AlertDialogTitle>
            <p className="text-sm font-medium text-text">{l.title}</p>
            <AlertDialogDescription>
              {t(
                "O negócio e seu histórico de atividades serão excluídos. O contato e as conversas continuam disponíveis.",
              )}
            </AlertDialogDescription>
            <p className="text-xs text-muted-foreground">{t("Esta ação não pode ser desfeita.")}</p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={excluir.isPending}>{t("Cancelar")}</AlertDialogCancel>
            {/* `preventDefault`: quem fecha é o `onSuccess`, para um erro não
                chegar sobre uma janela que já sumiu (mesmo padrão do quadro). */}
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={excluir.isPending}
              onClick={(e) => {
                e.preventDefault();
                excluir.mutate(
                  { action: "delete", lead_ids: [l.id], params: {} },
                  {
                    onSuccess: () => {
                      setConfirmandoExclusao(false);
                      onFechado();
                    },
                  },
                );
              }}
            >
              {excluir.isPending ? t("Excluindo…") : t("Excluir lead")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function CRMSidePanel({ conversation }: Props) {
  const { user, activeOrg } = useAuth();
  const readonly = user.support?.access_mode === "support_readonly";
  // Com a Agenda desligada na empresa (/app/crm), o atalho de marcar some.
  const agendaLigada = activeOrg?.capacidades_ligadas?.includes("agenda") ?? false;
  const localeDaData = useLocaleDeData();
  const t = useT();
  const contact = conversation?.contacts ?? null;
  const contactId = contact?.id ?? null;
  const [desfechoDraft, setDesfechoDraft] = useState<DesfechoDraft | null>(null);
  // A saída do filtro produz null enquanto o detalhe carrega. O rascunho não
  // some nessa lacuna; outra conversa/contato real o descarta, sem expô-lo.
  useEffect(() => {
    if (
      conversation &&
      desfechoDraft &&
      (conversation.id !== desfechoDraft.conversationId || contactId !== desfechoDraft.contactId)
    )
      setDesfechoDraft(null);
  }, [conversation, contactId, desfechoDraft]);

  const [enrichment, setEnrichment] = useState<
    (ProspectEnrichment & { collected_at: string }) | null
  >(null);
  const [enrichmentError, setEnrichmentError] = useState(false);
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [activities, setActivities] = useState<ActivityRow[] | null>(null);
  const [demandas, setDemandas] = useState<DemandaRow[] | null>(null);
  const [fatos, setFatos] = useState<Array<{ id: string; headline: string; body: string }>>([]);
  const [historico, setHistorico] = useState<
    Array<{ id: string; desfecho: string; fechada_em: string }>
  >([]);
  const [summaryContactId, setSummaryContactId] = useState<string | null>(null);
  /**
   * O TERCEIRO ESTADO. Antes existiam dois — carregando e "tem N itens" — e a
   * falha era traduzida para lista vazia, virando "Sem leads.": uma afirmação
   * sobre o NEGÓCIO feita em cima de um erro de leitura. Distinguir "não tem"
   * de "não consegui ler" é a diferença entre informar e mentir.
   */
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  // "Ver mais" abre de 3 em 3 (o total vem da rota, `leads_total`).
  // Guardado JUNTO do contato: trocar de conversa volta a 3 sem efeito de reset.
  const [limitePorContato, setLimitePorContato] = useState<{ contato: string | null; n: number }>({
    contato: null,
    n: 3,
  });
  const limiteLeads = limitePorContato.contato === contactId ? limitePorContato.n : 3;
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadAberto, setLeadAberto] = useState<LeadRow | null>(null);
  const [perdendo, setPerdendo] = useState<LeadRow | null>(null);
  // Ganhar/perder: a régua das rotas /win e /lose (agent+, sem suporte só-leitura).
  const podeFechar =
    !readonly &&
    (user.is_platform_admin || (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false));
  const defaultPipeline = useDefaultPipeline(leadDialogOpen);

  useEffect(() => {
    if (leadDialogOpen && defaultPipeline.isError) {
      toast.error(t("Nenhum funil configurado nesta organização."));
      setLeadDialogOpen(false);
    }
  }, [leadDialogOpen, defaultPipeline.isError, t]);

  useEffect(() => {
    if (!contactId) {
      setLeads(null);
      setOrders(null);
      setActivities(null);
      setDemandas(null);
      setFatos([]);
      setHistorico([]);
      setLeadAberto(null);
      return;
    }
    let cancelled = false;

    setErro(false);

    // Pela ROTA, não pelo cliente de navegador: o cookie de sessão é httpOnly,
    // então o supabase-js do browser não vê a sessão e consultava como `anon`
    // (medido: role=anon com gerente logado). Ver o cabeçalho da rota.
    async function load() {
      try {
        const r = await apiClient.get<{
          data: {
            enrichment?: (ProspectEnrichment & { collected_at: string }) | null;
            enrichment_error?: boolean;
            leads: LeadRow[];
            leads_total?: number;
            orders: OrderRow[];
            activities: ActivityRow[];
            demandas: DemandaRow[];
            fatos?: Array<{ id: string; headline: string; body: string }>;
            historico?: Array<{ id: string; desfecho: string; fechada_em: string }>;
          };
        }>(`/api/v1/contacts/${contactId}/crm-summary?leads_limit=${limiteLeads}`);
        if (cancelled) return;
        setSummaryContactId(contactId);
        setEnrichment(r.data.enrichment ?? null);
        setEnrichmentError(r.data.enrichment_error ?? false);
        setLeads(r.data.leads);
        setLeadsTotal(r.data.leads_total ?? r.data.leads.length);
        setOrders(r.data.orders);
        setActivities(r.data.activities);
        // `?? []` e não `?? null`: aqui a leitura DEU CERTO. Cair em `null`
        // faria a lista vazia se disfarçar do terceiro estado e o painel
        // mostraria esqueleto para sempre num contato sem demanda aberta —
        // que é o caso saudável.
        setDemandas(r.data.demandas ?? []);
        setFatos(r.data.fatos ?? []);
        setHistorico(r.data.historico ?? []);
      } catch {
        if (cancelled) return;
        // Falha NÃO vira lista vazia. Os dados ficam `null` e o painel diz que
        // não conseguiu ler — nunca que não há.
        setErro(true);
        setLeads(null);
        setOrders(null);
        setActivities(null);
        setDemandas(null);
        setFatos([]);
        setHistorico([]);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // AS DUAS DEPS NOVAS SÃO O REFETCH DA TROCA DE COMANDO.
    //
    // Este painel não usa react-query: ele busca num `useEffect` e guarda em
    // `useState`, então `invalidateQueries` não o alcança — e os hooks de
    // claim/transfer/release/pausar invalidam só as chaves de conversa. Resultado
    // medido: as quatro atividades novas ("Assumiu a conversa" e irmãs) nasciam no
    // banco e a seção "Atividade" ao lado NUNCA as mostrava, porque `contactId` não
    // muda quando o dono muda e o painel fica montado o tempo todo.
    //
    // Depender do DADO que muda é mais honesto que um contador de invalidação:
    // `assigned_to_user_id` cobre assumir/transferir/liberar e `bot_silenced_until`
    // cobre pausar e devolver — que são exatamente os quatro gestos que geram linha.
  }, [
    contactId,
    contact?.is_anonymized,
    tentativa,
    limiteLeads,
    conversation?.assigned_to_user_id,
    conversation?.bot_silenced_until,
    conversation?.service_revision,
    conversation?.current_demanda_id,
  ]);

  // Recarrega o resumo pelo MESMO caminho do "Tentar de novo": o efeito depende
  // de `tentativa`, então a demanda recém-marcada volta do servidor em vez de
  // ser apagada da lista no cliente. Sumir no otimismo esconderia uma escrita
  // que falhou depois — e escrita que parece ter dado certo é o defeito que
  // esta tela inteira combate.
  const recarregar = useCallback(() => setTentativa((n) => n + 1), []);

  // Otimista: chips e editor leem a MESMA lista, que muda no clique.
  const { tags, aplicar: aplicarTags } = useTagsDoContato(contactId ?? "", contact?.tags ?? []);
  const displayName = rotuloDoContato(contact, t);

  // `erro` PRIMEIRO, e não é detalhe: as três listas voltam a `null` quando a
  // leitura falha, e este derivado lê `null` como "ainda não chegou". Sem esta
  // guarda o painel mostraria esqueleto para sempre e o estado de falha nunca
  // apareceria — o mesmo colapso de significados que criou o defeito original,
  // só que trocando "erro→vazio" por "erro→carregando".
  const sectionsLoading = useMemo(
    () =>
      !erro &&
      (summaryContactId !== contactId ||
        (leads === null && orders === null && activities === null && demandas === null)),
    [erro, summaryContactId, contactId, leads, orders, activities, demandas],
  );

  if (!conversation) {
    return (
      <aside className="flex h-full items-center justify-center border-l border-border p-4 text-center text-xs text-muted-foreground">
        {t("Selecione uma conversa para ver detalhes do contato.")}
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col gap-3 overflow-y-auto border-l border-border bg-muted/20 p-3">
      <BlocoRecolhivel
        id="inbox-contato"
        titulo={t("Contato")}
        icone={<UserCircle size={14} aria-hidden />}
      >
        <div className="space-y-2 text-sm">
          <div className="font-medium">{displayName}</div>
          {contact?.phone_number && (
            <div className="text-xs text-muted-foreground">
              {phoneForDisplay(contact.phone_number)}
            </div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <ChipDeEtiqueta
                  key={t}
                  tag={t}
                  entidade="contact"
                  className="h-4 px-1.5 text-[10px]"
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {agendaLigada && contactId && conversation ? (
              <Link
                className="underline"
                href={`/app/agenda?contato=${contactId}&conversa=${conversation.id}`}
              >
                {t("Marcar compromisso")}
              </Link>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={readonly || !contactId}
              aria-pressed={tagEditorOpen}
              onClick={() => setTagEditorOpen((v) => !v)}
            >
              <Tag size={12} className="mr-1" weight="regular" aria-hidden /> {t("Tags do contato")}
            </Button>
            {contactId && (
              <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                <Link href={`/app/contacts/${contactId}`}>
                  {t("Ver contato")}
                  <ArrowRight size={12} className="ml-1" weight="regular" aria-hidden />
                </Link>
              </Button>
            )}
          </div>
          {tagEditorOpen && contactId && <ContactTagsEditor tags={tags} onChange={aplicarTags} />}
        </div>
      </BlocoRecolhivel>

      <BlocoRecolhivel
        id="inbox-oportunidades"
        data-testid="inbox-campos-lead"
        titulo={t("Leads recentes")}
        icone={<Funnel size={14} aria-hidden />}
        contagem={leadsTotal}
        acoes={
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs text-accent"
            disabled={readonly || !contactId || (leadDialogOpen && defaultPipeline.isLoading)}
            onClick={() => setLeadDialogOpen(true)}
          >
            <Plus size={12} className="mr-0.5" weight="bold" aria-hidden />
            {leadDialogOpen && defaultPipeline.isLoading ? t("Carregando…") : t("Novo Lead")}
          </Button>
        }
      >
        {sectionsLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : leads && leads.length > 0 ? (
          <>
            <LeadsRecentes
              leads={leads}
              contactId={contactId}
              usuarioId={user.id}
              onAbrir={setLeadAberto}
              podeFechar={podeFechar}
              onPerder={setPerdendo}
              onFechado={recarregar}
            />
            {leadsTotal > leads.length && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 h-7 w-full text-xs"
                data-testid="inbox-leads-ver-mais"
                onClick={() =>
                  setLimitePorContato({ contato: contactId ?? null, n: limiteLeads + 3 })
                }
              >
                {t("Ver mais")}
              </Button>
            )}
          </>
        ) : (
          <SemLista
            vazio="Sem leads."
            erro={erro}
            onTentarDeNovo={() => setTentativa((n) => n + 1)}
          />
        )}
        {leadAberto && leads?.some((l) => l.id === leadAberto.id) && (
          <LeadDossierDoFunil
            pipelineId={leadAberto.pipeline_id}
            leadId={leadAberto.id}
            titulo={leadAberto.title}
            onClose={() => {
              setLeadAberto(null);
              recarregar();
            }}
          />
        )}
        {perdendo && (
          <LoseLeadDialog
            open
            onOpenChange={(v) => {
              if (!v) {
                setPerdendo(null);
                recarregar();
              }
            }}
            leadId={perdendo.id}
            pipelineId={perdendo.pipeline_id}
          />
        )}
      </BlocoRecolhivel>

      <LeadEnrichment
        data={
          summaryContactId === contactId && !erro && !contact?.is_anonymized ? enrichment : null
        }
        loading={sectionsLoading}
        error={erro || (summaryContactId === contactId && enrichmentError)}
        onRetry={recarregar}
      />

      {contactId && defaultPipeline.data && (
        <NewLeadDialog
          open={leadDialogOpen}
          onOpenChange={setLeadDialogOpen}
          pipelineId={defaultPipeline.data.pipeline.id}
          stages={defaultPipeline.data.stages}
          contactId={contactId}
          onCreated={() => {
            recarregar();
          }}
        />
      )}

      {/* ANTES dos negócios de propósito (doutrina cap. 5): lead é o negócio,
          conversa é o canal, demanda é o que precisa acabar. Quem abre esta
          conversa está atendendo alguém que pediu alguma coisa — a primeira
          pergunta a responder é o que ainda está pendente, não quanto vale. */}
      <BlocoRecolhivel
        id="inbox-demandas"
        data-testid="inbox-demandas"
        titulo={t("Demandas abertas")}
        icone={<Flag size={14} aria-hidden />}
        contagem={demandas?.length ?? null}
      >
        {sectionsLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : demandas && demandas.length > 0 ? (
          <ul className="space-y-1.5">
            {demandas.map((d) => {
              const semPasso = !d.proximo_passo;
              return (
                <li
                  key={d.id}
                  data-testid={semPasso ? "demanda-sem-proximo-passo" : "demanda-com-proximo-passo"}
                  className={cn(
                    "rounded-md border p-2 text-xs",
                    semPasso ? "border-warning-border bg-warning-bg/40" : "border-border",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">
                      {t(ESTADO_LEGIVEL[d.estado] ?? d.estado)}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {t("há {tempo}").replace("{tempo}", `${horasDesde(d.aberta_em)}h`)}
                    </span>
                  </div>
                  {/* O invariante 4 na frase, não só na cor: quem enxerga mal
                      cor precisa ler a mesma informação. */}
                  <div className={cn("mt-0.5", semPasso ? "font-medium" : "text-muted-foreground")}>
                    {d.proximo_passo === PROXIMO_PASSO_DA_MENSAGEM_NOVA
                      ? t("Responder à nova mensagem do cliente")
                      : (d.proximo_passo ?? t("Sem próximo passo definido"))}
                  </div>
                  {/* A SAÍDA. Sem ela esta seção só denunciava: o atendente via o
                      vazamento e tinha de sair da tela para resolver — peça que
                      só recebe é ilha pelo invariante 1, e foi o gate dos mapas
                      de arquitetura que apontou isso. */}
                  {d.id === conversation.current_demanda_id && (
                    <Badge variant="outline">{t("Demanda vigente neste canal")}</Badge>
                  )}
                  {!readonly && (
                    <EncerrarDemanda
                      draft={
                        desfechoDraft?.conversationId === conversation.id &&
                        desfechoDraft.contactId === contactId &&
                        desfechoDraft.demandaId === d.id
                          ? desfechoDraft
                          : null
                      }
                      onAbrir={() => {
                        if (contactId)
                          setDesfechoDraft({
                            conversationId: conversation.id,
                            contactId,
                            demandaId: d.id,
                            revision: d.revision,
                            desfecho: "resolvida",
                            salvando: false,
                          });
                      }}
                      onAlterar={(patch) =>
                        setDesfechoDraft((current) =>
                          current?.conversationId === conversation.id &&
                          current.contactId === contactId &&
                          current.demandaId === d.id
                            ? { ...current, ...patch }
                            : current,
                        )
                      }
                      onFechar={() =>
                        setDesfechoDraft((current) =>
                          current?.conversationId === conversation.id &&
                          current.contactId === contactId &&
                          current.demandaId === d.id
                            ? null
                            : current,
                        )
                      }
                      onPronto={recarregar}
                    />
                  )}
                  {semPasso && !readonly ? (
                    <MarcarProximoPasso demandaId={d.id} onPronto={recarregar} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <SemLista
            vazio="Nenhuma demanda aberta."
            erro={erro}
            onTentarDeNovo={() => setTentativa((n) => n + 1)}
          />
        )}
      </BlocoRecolhivel>

      <BlocoRecolhivel
        id="inbox-memoria"
        data-testid="inbox-memoria"
        titulo={t("Memória do contato")}
        icone={<Brain size={14} aria-hidden />}
        contagem={fatos.length}
      >
        <p className="text-xs text-muted-foreground">
          {t("Fatos duráveis registrados nas notas. Pendências pertencem à demanda vigente.")}
        </p>
        {!sectionsLoading &&
          fatos.map((f) => (
            <details key={f.id} className="mt-2 text-xs">
              <summary className="wrap-anywhere">{f.headline}</summary>
              <p className="mt-1 wrap-anywhere whitespace-pre-wrap">{f.body}</p>
            </details>
          ))}
        {!sectionsLoading && fatos.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Nenhum fato durável registrado.")}
          </p>
        )}
        {!sectionsLoading && historico.length > 0 && (
          <div className="mt-3 text-xs">
            <h4>{t("Histórico encerrado — sem tarefas pendentes")}</h4>
            {historico.map((h) => (
              <p key={h.id}>
                {t(DESFECHO_LEGIVEL[h.desfecho] ?? h.desfecho)}
                {h.fechada_em ? ` · ${shortDate(h.fechada_em, localeDaData)}` : ""}
              </p>
            ))}
          </div>
        )}
      </BlocoRecolhivel>

      {/* O que os roteiros de atendimento coletaram (módulo opcional; desligado
          ou sem roteiro, não desenha nada). */}
      {contactId && !contact?.is_anonymized && (
        <RoteirosDoContato contactId={contactId} variante="painel" />
      )}

      <BlocoRecolhivel
        id="inbox-pedidos"
        titulo={t("Pedidos recentes")}
        icone={<Receipt size={14} aria-hidden />}
        contagem={orders?.length ?? null}
      >
        {sectionsLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : orders && orders.length > 0 ? (
          <ul className="space-y-1.5">
            {orders.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1 truncate font-medium">
                    <Receipt size={11} weight="regular" aria-hidden />
                    {o.external_id ?? o.id.slice(0, 8)}
                  </div>
                  <div className="text-muted-foreground">
                    {o.status ?? "—"} · {formatMoney(o.total_cents, o.currency)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista
            vazio="Sem pedidos."
            erro={erro}
            onTentarDeNovo={() => setTentativa((n) => n + 1)}
          />
        )}
      </BlocoRecolhivel>

      <BlocoRecolhivel
        id="inbox-atividade"
        titulo={t("Atividade")}
        icone={<ClockCounterClockwise size={14} aria-hidden />}
      >
        {sectionsLoading ? (
          <Skeleton className="h-14 w-full" />
        ) : activities && activities.length > 0 ? (
          <ul className="space-y-1.5">
            {activities.map((a) => (
              <li key={a.id} className="rounded-md border border-border p-2 text-xs">
                {/* Rótulo do vocabulário único (activity-vocabulary), nunca o
                    tipo cru: a tela e o banco divergiram justamente por manter
                    duas listas. Marcador por ator, forma e não cor (§5). */}
                <div className="flex items-center gap-1.5 font-medium">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0",
                      actorShape(a.actor_kind) === "filled" && "rounded-full bg-accent",
                      actorShape(a.actor_kind) === "ring" &&
                        "rounded-full border border-accent bg-surface",
                      actorShape(a.actor_kind) === "dashed" &&
                        "rounded-full border border-dashed border-border-strong",
                    )}
                    aria-hidden
                  />
                  {t(activityLabel(a.type))}
                </div>
                {a.reason && (
                  <div className="mt-0.5 truncate text-muted-foreground">{t(a.reason)}</div>
                )}
                <div className="text-muted-foreground">
                  {a.performed_by_name ?? t(actorLabel(a.actor_kind))} ·{" "}
                  {shortDate(a.performed_at, localeDaData)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <SemLista
            vazio="Sem atividade."
            erro={erro}
            onTentarDeNovo={() => setTentativa((n) => n + 1)}
          />
        )}
      </BlocoRecolhivel>

      {/* Perguntar ao acervo — a MESMA busca que a IA faz, com a origem de cada
          trecho. Não é busca própria: o componente só pergunta e mostra, e quem
          decide limiar/top-K é a rota, que chama `buscarConhecimento`. Colocada
          DEPOIS das seções de trabalho: é consulta, não é o que o atendente abre
          a conversa para fazer. */}
      <BlocoRecolhivel
        id="inbox-acervo"
        titulo={t("Acervo")}
        icone={<BookOpen size={14} aria-hidden />}
      >
        <p className="mb-2 text-xs text-muted-foreground">
          {t("Pergunte como a IA perguntaria — a resposta vem com a origem de cada trecho.")}
        </p>
        <AcervoSearch />
      </BlocoRecolhivel>
    </aside>
  );
}
