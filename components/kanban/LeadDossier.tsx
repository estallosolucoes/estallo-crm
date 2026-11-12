"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm } from "./LeadFieldsForm";
import { ScoreSlot } from "./ScoreSlot";
import { LeadTimeline } from "./LeadTimeline";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { TarefasDoNegocio } from "./TarefasDoNegocio";
import { OwnerBadge } from "./OwnerBadge";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import type { Stage } from "@/lib/kanban/types";
import { Button } from "@/components/ui/button";
import { ClockCounterClockwise, Funnel, ListChecks, UserCircle } from "@/lib/ui/icons";
import { BlocoRecolhivel } from "@/components/ui/bloco-recolhivel";
import { TrilhoDeEtapas } from "./TrilhoDeEtapas";
import { MoveToOtherPipelineDialog } from "./MoveToOtherPipelineDialog";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
  /** As etapas do funil — alimentam o trilho do topo. Sem elas, não há trilho. */
  stages?: Stage[];
  /**
   * Desenha só o CONTEÚDO, dentro de uma gaveta que quem chama já abriu (o
   * Inbox abre a gaveta na hora do clique e preenche quando o quadro chega —
   * trocar de gaveta no meio faria a animação de entrada rodar duas vezes).
   */
  embutido?: boolean;
}

/** A gaveta do dossiê — a mesma medida aberta pelo quadro e pelo Inbox. */
export const CLASSE_DA_GAVETA_DO_LEAD =
  // Sem padding EMBAIXO: o rodapé fixo do "Salvar" encosta na borda da gaveta.
  "painel-do-lead flex w-full flex-col gap-3 overflow-y-auto px-4 pt-5 pb-0 sm:max-w-2xl sm:px-6 sm:pt-6 sm:pb-0";

function formatValor(cents: number | null, currency: string | null): string {
  // Mesma régua e mesmo locale do card e do total da coluna (`formatValorDoNegocio`).
  if (cents === null) return "—";
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/**
 * O dossiê do negócio: cabeçalho vivo → timeline → campos.
 *
 * A ORDEM É a mudança em relação ao diálogo de edição: quem abre um lead quer
 * primeiro saber O QUE ACONTECEU, e só depois mexer. O formulário íntegro fica
 * por último, e o cabeçalho tem um atalho para ele — ordem preservada, custo de
 * rolagem resolvido.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 */
export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
  stages,
  embutido = false,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const campos = useRef<HTMLDivElement | null>(null);
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  // N1 — o atalho "Nova proposta" é manager+ (mesmo gate do envio, mesma
  // régua do BulkActionBar). O dossiê não tinha nenhuma checagem de papel;
  // esta é a primeira, no padrão já estabelecido do kanban.
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin ||
    (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) ||
    false;
  // Tarefas são `agent`+, a mesma régua da tela de Tarefas e da rota — e o
  // suporte temporário só lê, como lá (`requireSupportWrite`).
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);
  // Mover, ganhar, perder e trocar de funil: a mesma régua (agent+, sem
  // suporte só-leitura) das rotas de mover, ganhar, perder e trocar de funil.
  const podeMover = podeEditarTarefas;
  const aberto = lead.status === "open";
  const [moverAberto, setMoverAberto] = useState(false);

  const observaveis = {
    // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
    // aconteceu" têm a mesma aparência, que é silêncio.
    "data-realtime-status": timeline.realtimeStatus.toLowerCase(),
    // Observável como no board: "a entrega morreu" e "nada aconteceu"
    // têm a mesma aparência, e no dossiê a segunda é ainda mais crível —
    // negócio sem novidade é um estado normal.
    "data-refetch-divergencias": timeline.seguranca.divergencias,
  };
  const conteudo = (
    <>
      <SheetHeader className="pr-8">
        <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap">
          <SheetTitle className="min-w-0 basis-full text-base leading-6 font-semibold tracking-[-0.3px] sm:basis-auto">
            {lead.title}
          </SheetTitle>
          {podeMover && aberto && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 border-border-strong bg-transparent px-2 text-xs hover:border-accent hover:bg-transparent hover:text-accent"
              onClick={() => setMoverAberto(true)}
              data-testid="dossie-mover-de-funil"
            >
              <Funnel size={12} className="mr-1" aria-hidden />
              {t("Mover de funil")}
            </Button>
          )}
        </div>
      </SheetHeader>

      {stages && stages.length > 0 && (
        <div className="my-3">
          <TrilhoDeEtapas
            lead={lead}
            stages={stages}
            pipelineId={pipelineId}
            // Ganho/perdido também sai pelo trilho: o trilho pergunta antes
            // "Criar novo lead × Mover lead existente" (30/10/2026).
            podeMover={podeMover}
          />
        </div>
      )}

      {/* ① cabeçalho vivo */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-strong pb-3 text-xs">
        <span className="font-semibold text-text tabular-nums">
          {formatValor(lead.value_cents, lead.currency)}
        </span>
        <span className="text-text-muted">{stageName}</span>
        <OwnerBadge
          ownerKind={owner.kind}
          ownerName={owner.name}
          agentVersion={owner.agentVersion}
        />
        {score && (
          // O MESMO componente do card, não uma cópia do medidor.
          // "Superfície nova herda as decisões da antiga" só vale como
          // mecanismo: herdar por cópia é como as duas listas do evidence —
          // funciona hoje e diverge no mês em que alguém mudar um dos dois.
          // De brinde, o rótulo honesto da âncora ("registro que sustenta",
          // nunca "momento da conversa") vem junto, sem eu reescrever nada.
          <ScoreSlot
            probability={score.probability}
            band={score.band}
            reason={score.reason}
            factors={score.factors.slice(0, 3)}
          />
        )}

        <button
          type="button"
          onClick={() => campos.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="ml-auto text-accent underline-offset-[3px] hover:underline"
        >
          {t("Editar campos")}
        </button>
      </div>

      {/* O score NÃO aparece na timeline: recálculo é telemetria e não emite
            atividade (silêncio para telemetria, pulso para mudança de estado).
            Sem esta linha, quem visse o número mudando no cabeçalho e nunca na
            timeline concluiria que a timeline está incompleta. */}
      {score?.at && (
        <p className="-mt-1 text-[11px] leading-4 text-text-muted">
          {t("Probabilidade recalculada automaticamente")} ·{" "}
          {new Date(score.at).toLocaleString(tagDoIdioma)}
        </p>
      )}

      <ConversaNoDossie
        conversa={lead.conversa}
        contactId={lead.contact_id}
        phone={lead.contact_phone}
      />

      {/* Os dados do CLIENTE: telefone e e-mail numa aba, links (Instagram,
            site, Google Meu Negócio…) na outra. Vêm do contato, não do lead. */}
      <BlocoRecolhivel
        id="dossie-contato"
        titulo={t("Contato")}
        icone={<UserCircle size={14} aria-hidden />}
      >
        <ContatoDoNegocio
          contactId={lead.contact_id}
          pipelineId={pipelineId}
          leadId={lead.id}
          lead={{ pipeline_id: lead.pipeline_id, stage_id: lead.stage_id }}
        />
      </BlocoRecolhivel>

      {/* As tarefas ANTES da linha do tempo: a timeline conta o que já
            aconteceu, a tarefa é o que ainda falta fazer — e quem abre o card
            para agir procura o próximo passo primeiro. */}
      <TarefasDoNegocio
        leadId={lead.id}
        contactId={lead.contact_id}
        podeEditar={podeEditarTarefas}
        aberto={open}
      />

      {/* ② timeline */}
      <BlocoRecolhivel
        id="dossie-linha-do-tempo"
        titulo={t("Linha do tempo")}
        icone={<ClockCounterClockwise size={14} aria-hidden />}
      >
        <LeadTimeline
          itens={timeline.itens}
          chegouAoVivo={timeline.chegouAoVivo}
          isLoading={timeline.isLoading}
          isError={timeline.isError}
          onRetry={timeline.refetch}
        />
      </BlocoRecolhivel>

      {/* ③ campos, por último */}
      <div ref={campos}>
        <BlocoRecolhivel
          id="dossie-dados"
          titulo={t("Dados do negócio")}
          icone={<ListChecks size={14} aria-hidden />}
          // Recolher a ficha não desmonta o campo em edição (a gravação dele sai no blur).
          manterMontado
        >
          <LeadFieldsForm
            lead={lead}
            pipelineId={pipelineId}
            fieldDefs={fieldDefs}
          />
        </BlocoRecolhivel>
      </div>

      {/* N1 — seção "Propostas", depois de "Dados do negócio". Some sozinha
            (null) quando a capacidade está desligada — ver PropostasDoNegocio. */}
      <PropostasDoNegocio leadId={lead.id} pipelineId={pipelineId} podeCriar={podeCriarProposta} />
      <MoveToOtherPipelineDialog
        open={moverAberto}
        onOpenChange={setMoverAberto}
        leadId={lead.id}
        pipelineId={pipelineId}
        expectedUpdatedAt={lead.updated_at}
      />
    </>
  );

  if (embutido) {
    return (
      <div className="contents" {...observaveis}>
        {conteudo}
      </div>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={CLASSE_DA_GAVETA_DO_LEAD} {...observaveis}>
        {conteudo}
      </SheetContent>
    </Sheet>
  );
}
