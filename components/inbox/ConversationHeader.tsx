"use client";
import { useMemo, useState, type RefObject } from "react";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import {
  ArrowRight,
  ArrowsLeftRight,
  CaretLeft,
  Check,
  DotsThree,
  MagnifyingGlass,
  Robot,
  SidebarSimple,
  UserCircle,
  VideoCamera,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { SnoozeButton } from "@/components/inbox/SnoozeButton";
import { DialButton } from "@/components/voice/DialButton";
import { servidorDeVideo } from "@/lib/video/jitsi";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useReleaseConversation } from "@/hooks/inbox/useReleaseConversation";
import {
  useMarkPersonalContact,
  useUnmarkPersonalContact,
} from "@/hooks/contacts/usePersonalContact";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  useCloseConversation,
  useReopenConversation,
} from "@/hooks/inbox/useCloseConversation";
import { useResumeAiAttendance } from "@/hooks/inbox/useResumeAiAttendance";
import { usePauseAiAttendance } from "@/hooks/inbox/usePauseAiAttendance";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { comandoDaConversa, ROTULO_DO_MOTIVO } from "@/lib/inbox/comando-da-conversa";
import { ReassignDialog } from "@/components/inbox/ReassignDialog";
import { VideoCallButton } from "@/components/inbox/VideoCallButton";
import { motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";

interface Props {
  conversation: ConversationWithContact;
  /**
   * A busca DENTRO da conversa (#1793): abre um campo que filtra só as
   * mensagens já carregadas. O ref devolve o foco a este botão quando o campo
   * fecha — senão o Esc largava o foco no `body`.
   */
  onBuscar?: () => void;
  buscaAberta?: boolean;
  botaoBuscaRef?: RefObject<HTMLButtonElement | null>;
  /** Seleciona outra conversa no Inbox — a aba Número do Transferir abre a do outro número. */
  onAbrirConversa?: (id: string) => void;
  /** A ficha do contato está à vista (coluna ou gaveta) — pinta o botão da ficha. */
  fichaVisivel?: boolean;
  /** Mostra/esconde a ficha do contato (o botão à direita do cabeçalho). */
  onAlternarFicha?: () => void;
  /** A seta de voltar para a lista — só aparece onde há uma coluna por vez. */
  onVoltar?: () => void;
}

/**
 * O CHIP NOMEIA CICLO DE VIDA, NÃO COMANDO.
 *
 * Ele afirmava quem manda — "Automático atendendo", "Aguardando atendente" — a
 * 20px de um selo que responde a MESMA pergunta por outra fonte, e as duas se
 * contradiziam na tela: `conversations.status` não acompanha silêncio, trava de
 * contato nem atribuição, e o motor nunca o lê. Medido em 2026-08-30 num print
 * do dono: "Aguardando atendente" e "Automático" no mesmo cabeçalho.
 *
 * Quem responde "quem manda" é o `OwnerBadge`, que vem de `comandoDaConversa`.
 * Aqui fica só o que o status realmente sabe: o episódio está aberto ou acabou.
 *
 * Cobre os SETE valores do CHECK de propósito — o call site é
 * `t(STATUS_LABEL[status] ?? status)`, e um buraco imprime o token cru em inglês
 * no rosto do atendente. Vigiado pelo invariante de espelho.
 */
const STATUS_LABEL: Record<string, string> = {
  open: "Aberta",
  pending: "Aberta",
  claimed: "Aberta",
  ai_handling: "Aberta",
  resolved: "Resolvida",
  closed: "Fechada",
  archived: "Arquivada",
};

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return (partes[0] ?? "").slice(0, 2).toUpperCase();
  return ((partes[0]?.[0] ?? "") + (partes[partes.length - 1]?.[0] ?? "")).toUpperCase();
}

export function ConversationHeader({
  conversation,
  onAbrirConversa,
  onBuscar,
  buscaAberta,
  botaoBuscaRef,
  fichaVisivel = false,
  onAlternarFicha,
  onVoltar,
}: Props) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const claim = useClaimConversation();
  const release = useReleaseConversation();
  const close = useCloseConversation();
  const reopen = useReopenConversation();
  const retomar = useResumeAiAttendance();
  const pausar = usePauseAiAttendance();
  // "Existe automático nesta org?" — sem isto o selo afirmava que o robô estava
  // atendendo em instalação que nunca configurou agente nenhum.
  const automaticoDaOrg = useAutomaticoAtivo();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [confirmFecharOpen, setConfirmFecharOpen] = useState(false);
  const [confirmPessoalOpen, setConfirmPessoalOpen] = useState(false);
  const [videoAberto, setVideoAberto] = useState(false);
  const temVideo = useMemo(() => servidorDeVideo() !== null, []);

  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  /**
   * POR ONDE ESTA CONVERSA ENTROU — o mesmo rótulo da lista e da tela de
   * canais (#2383). `null` quando não há canal, e aí o badge não existe.
   */
  const rotuloCanal = rotuloDoCanalDaConversa(conversation.channel_sessions, t);
  const phone = c?.phone_number ? phoneForDisplay(c.phone_number) : null;
  const status = conversation.status;
  const isMineAssigned = conversation.assigned_to_user_id === user.id;
  const isOpen = status === "open" || conversation.assigned_to_user_id == null;

  // Marcar/desmarcar pessoal (spec 21, etapa 15 — botão no cabeçalho).
  //
  // GERENTE pode (spec decisão 1, D3): pessoal é decisão operacional — esconder
  // uma conversa da operação. Desbloquear exige ADMIN porque reabre um canal
  // que o cliente fechou (direito do titular, LGPD): dois gestos parecidos,
  // dois gates diferentes, cada um com seu motivo.
  //
  // Os hooks ficam AQUI, antes de qualquer early return (a ordem dos hooks não
  // pode mudar entre renderizações); com contato ausente o id vazio nunca
  // dispara porque o botão nem é desenhado.
  const ehPessoal = c?.is_personal === true;
  const podeMarcarPessoal =
    (user.is_platform_admin && !user.support) ||
    (activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  const marcarPessoal = useMarkPersonalContact(c?.id ?? "");
  const desmarcarPessoal = useUnmarkPersonalContact(c?.id ?? "");

  /**
   * QUEM MANDA, uma pergunta com uma resposta.
   *
   * Este bloco era três leituras parciais. O selo e o botão de volta liam duas
   * travas (`bot_silenced_until || force_human`); a linha da lista lia uma, por
   * COR; o painel não lia nenhuma. Desde a 0173 há uma quarta situação —
   * "alguém assumiu" — e continuar somando condições à mão aqui é como as três
   * leituras divergiram em primeiro lugar. A regra mora em `lib/inbox`,
   * espelhando os gates que o MOTOR lê, e esta tela só a consome.
   */
  const { comando, automaticoAtivo, travaVigente, motivo } = comandoDaConversa({
    status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: conversation.contacts?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
    automaticoDaOrg: automaticoDaOrg.data,
  });

  const encerrada = status === "closed" || status === "archived" || status === "resolved";
  /**
   * A VOLTA aparece sempre que há algo a devolver — inclusive em conversa
   * ENCERRADA. Antes ela era condicionada a `status !== "closed"`, e o resultado
   * era um beco sem saída medido: atendente assume, fecha, sai de férias; a
   * conversa fica com o automático parado e, para qualquer colega, sem NENHUMA
   * porta — "Liberar" só existe para o próprio dono e a rota recusa quem não é.
   * `devolverAtendimentoAoAgente` funciona nesse estado (o status fechado está na
   * lista de reativáveis), então esconder o botão escondia uma ação que existe.
   *
   * A condição é `travaVigente`, e NÃO `!automaticoAtivo`: conversa encerrada tem
   * o automático inativo sem ter trava nenhuma, e sair do segundo faria o botão
   * aparecer em toda conversa fechada — clicá-lo REABRIRIA uma conversa que
   * ninguém pediu para reabrir. Oferecer uma ação que não deveria acontecer é
   * pior que não oferecer nenhuma.
   */
  const podeDevolver = travaVigente;
  /**
   * PAUSAR só aparece quando pausar é um gesto DIFERENTE de assumir.
   *
   * Desde a 0173 "Assumir" já cala o automático (a RPC grava o silêncio). Numa
   * conversa sem dono, portanto, "Assumir" e "Pausar o automático" teriam
   * exatamente o mesmo efeito — dois botões para um ato é a confusão que esta
   * entrega existe para acabar, não para dobrar.
   *
   * Sobra o caso em que ele é próprio: a conversa JÁ tem dono e o automático
   * continua de pé. Isso é real e não é raro — o rodízio (`reason='routing'`)
   * distribui sem calar, de propósito, senão uma org em round_robin ficaria sem
   * automático nenhum.
   */
  const podePausar =
    automaticoAtivo && !encerrada && conversation.assigned_to_user_id !== null;

  if (user.support?.access_mode === "support_readonly") return <header className="flex items-center justify-between border-b p-4">
    <strong>{displayName}</strong><span className="text-sm text-muted-foreground">{STATUS_LABEL[status] ?? status} · Somente leitura</span>
  </header>;
  // 16/10/2026 — o cabeçalho do MODELO do dono: identidade à esquerda (avatar,
  // nome, situação, telefone · quem manda) e, à direita, só o que se usa a
  // toda hora: buscar, Assumir/Liberar, Fechar/Reabrir, o "⋯" com o resto e o
  // botão da ficha. Transferir, Lembrar, pessoal, Devolver/Pausar o automático,
  // Ligar e Vídeo moram no "⋯" (antes eram botões que quebravam a barra em duas
  // linhas). Os rótulos e `data-testid` de cada ação continuam os mesmos.
  return (
    <>
    <div className="ibx-chat-header">
      {onVoltar && (
        <button
          type="button"
          className="ibx-icon-button ibx-show-list"
          onClick={onVoltar}
          aria-label={t("Voltar para a lista de conversas")}
          title={t("Conversas")}
        >
          <CaretLeft className="ibx-icon" aria-hidden />
        </button>
      )}
      <div className="ibx-chat-identity">
        <span className="ibx-avatar">
          <Avatar className="ibx-avatar-face">
            {c?.avatar_storage_path && !c?.is_anonymized ? (
              <AvatarImage src={`/api/v1/contacts/${c.id}/avatar`} alt="" className="object-cover" />
            ) : null}
            <AvatarFallback className="ibx-tom-areia text-[inherit] font-medium">
              {iniciais(displayName)}
            </AvatarFallback>
          </Avatar>
        </span>
        <div className="ibx-chat-identity-text">
          <div className="ibx-chat-name-row">
            <h2 className="ibx-chat-contact-name" title={displayName}>
              {displayName}
            </h2>
            <span className="ibx-status">{t(STATUS_LABEL[status] ?? status)}</span>
            {/* Ao lado do estado: a pergunta "dá para escrever agora?" se faz
                ANTES de digitar, não depois de um `failed` de cinco dígitos. */}
            <JanelaSelo
              provider={conversation.channel_sessions?.provider ?? null}
              lastInboundAt={conversation.last_inbound_at}
            />
            {/* #2383: por onde a conversa entrou — o mesmo texto da lista e da
                tela de canais. Sem canal, não existe. */}
            {rotuloCanal && (
              <Badge
                variant="outline"
                className="h-4 min-w-0 max-w-[9rem] truncate px-1.5 text-[10px]"
                title={`${t("Entrou por")} ${rotuloCanal}`}
                data-testid="canal-da-conversa"
              >
                <span className="truncate">{rotuloCanal}</span>
              </Badge>
            )}
          </div>
          <div className="ibx-chat-subtitle">
            <ChannelLogo channel={conversation.channel_sessions} size={11} />
            {phone && <span>{phone}</span>}
            {phone && <span aria-hidden>·</span>}
            {/* QUEM ESTÁ NO COMANDO — o mesmo componente do card do funil e do
                dossiê, para a pergunta ter uma resposta só. */}
            <span className="ibx-chat-owner" data-testid="comando-da-conversa">
              {comando.quem === "humano" ? (
                <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
              ) : comando.quem === "automatico" ? (
                <OwnerBadge ownerKind="ai" ownerName={t("Automático")} compacto />
              ) : (
                t("Sem responsável")
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="ibx-chat-actions">
        {onBuscar && (
          <button
            ref={botaoBuscaRef}
            type="button"
            className="ibx-icon-button ibx-busca-na-conversa"
            onClick={onBuscar}
            aria-label={t("Buscar nesta conversa")}
            title={t("Buscar nesta conversa")}
            aria-expanded={buscaAberta}
          >
            <MagnifyingGlass className="ibx-icon" aria-hidden />
          </button>
        )}
        {isOpen && (
          <button
            type="button"
            className="ibx-button ibx-primary"
            disabled={claim.isPending}
            // O rótulo NÃO muda (é contrato: `inbox-header-nao-trava` e o
            // dicionário de espanhol o citam). Desde a 0173 assumir também para
            // o atendimento automático, e o botão anuncia as duas coisas.
            title={t("Você passa a responder esta conversa e o atendimento automático para aqui.")}
            onClick={() =>
              claim.mutate({
                conversation_id: conversation.id,
                expected_assignee: conversation.assigned_to_user_id,
              })
            }
          >
            {t("Assumir")}
          </button>
        )}
        {isMineAssigned && (
          <button
            type="button"
            className="ibx-button ibx-secondary"
            disabled={release.isPending}
            onClick={() => release.mutate({ conversation_id: conversation.id })}
          >
            {t("Liberar")}
          </button>
        )}
        {!encerrada ? (
          <button
            type="button"
            className="ibx-button ibx-secondary ibx-close-conversation"
            disabled={close.isPending}
            onClick={() => setConfirmFecharOpen(true)}
            aria-label={t("Fechar")}
            title={t("Fechar")}
          >
            <Check className="ibx-icon" aria-hidden />
            <span>{t("Fechar")}</span>
          </button>
        ) : (
          <button
            type="button"
            className="ibx-button ibx-secondary"
            disabled={reopen.isPending}
            onClick={() =>
              reopen.mutate({
                conversation_id: conversation.id,
                expected_revision: conversation.service_revision,
              })
            }
          >
            {t("Reabrir")}
          </button>
        )}
        <span className="ibx-toolbar-divider" aria-hidden />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="ibx-icon-button"
              aria-label={t("Mais ações da conversa")}
              title={t("Mais ações da conversa")}
              data-testid="mais-acoes-da-conversa"
            >
              <DotsThree className="ibx-icon" weight="bold" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="ibx ibx-floating ibx-menu">
            {!encerrada && (
              <DropdownMenuItem className="ibx-menu-item" onSelect={() => setReassignOpen(true)}>
                <ArrowsLeftRight className="ibx-icon" aria-hidden />
                {t("Transferir")}
              </DropdownMenuItem>
            )}
            {!encerrada && (
              <SnoozeButton
                conversationId={conversation.id}
                snoozeUntil={conversation.snooze_until ?? null}
                comoItemDeMenu
              />
            )}
            {/* O INTERRUPTOR do automático: um item, dois rótulos — os dois
                estados são mutuamente exclusivos. Os `data-testid` são os de
                antes (`escalacao-ciclo` e afins os clicam). */}
            {podeDevolver && (
              <DropdownMenuItem
                className="ibx-menu-item"
                disabled={retomar.isPending}
                data-testid="devolver-ao-automatico"
                title={
                  motivo === "contato_travado"
                    ? t("Religa o atendimento automático para este cliente — vale para todas as conversas dele.")
                    : t("Devolve esta conversa ao atendimento automático.")
                }
                onSelect={() => retomar.mutate({ conversation_id: conversation.id })}
              >
                <Robot className="ibx-icon" aria-hidden />
                {retomar.isPending ? t("Devolvendo...") : t("Devolver ao automático")}
              </DropdownMenuItem>
            )}
            {podePausar && (
              <DropdownMenuItem
                className="ibx-menu-item"
                disabled={pausar.isPending}
                data-testid="pausar-o-automatico"
                title={t("O atendimento automático para nesta conversa. O dono não muda.")}
                onSelect={() => pausar.mutate({ conversation_id: conversation.id })}
              >
                <Robot className="ibx-icon" aria-hidden />
                {pausar.isPending ? t("Pausando...") : t("Pausar o automático")}
              </DropdownMenuItem>
            )}
            {/* PESSOAL (spec 21, etapa 15). O `data-testid` é contrato do e2e. */}
            {podeMarcarPessoal && c?.id && !ehPessoal && (
              <DropdownMenuItem
                className="ibx-menu-item"
                disabled={marcarPessoal.isPending}
                data-testid="marcar-pessoal"
                title={t("Tira este contato da operação: a conversa sai do inbox.")}
                onSelect={() => setConfirmPessoalOpen(true)}
              >
                <UserCircle className="ibx-icon" aria-hidden />
                {t("Marcar como pessoal")}
              </DropdownMenuItem>
            )}
            {podeMarcarPessoal && c?.id && ehPessoal && (
              <DropdownMenuItem
                className="ibx-menu-item"
                disabled={desmarcarPessoal.isPending}
                data-testid="desmarcar-pessoal"
                title={t("Devolve este contato à operação: a conversa volta ao inbox.")}
                onSelect={() => desmarcarPessoal.mutate()}
              >
                <UserCircle className="ibx-icon" aria-hidden />
                {desmarcarPessoal.isPending ? t("Desmarcando...") : t("Desmarcar pessoal")}
              </DropdownMenuItem>
            )}
            <div className="ibx-menu-separator" role="separator" />
            {/* A chamada usa o telefone da ficha; grupos não têm uma pessoa
                para ligar. A régua (sessão de voz pareada) mora no DialButton. */}
            {!conversation.is_group && c?.id && (
              <DialButton contactId={c.id} hasPhone={!!c.phone_number} comoItemDeMenu />
            )}
            {temVideo && (
              <DropdownMenuItem
                className="ibx-menu-item"
                data-testid="btn-videochamada"
                onSelect={() => setVideoAberto(true)}
              >
                <VideoCamera className="ibx-icon" aria-hidden />
                {t("Videochamada")}
              </DropdownMenuItem>
            )}
            {c?.id && (
              <DropdownMenuItem className="ibx-menu-item" asChild>
                <Link href={`/app/contacts/${c.id}`}>
                  <ArrowRight className="ibx-icon" aria-hidden />
                  {t("Ver contato")}
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {onAlternarFicha && (
          <button
            type="button"
            className={cn("ibx-icon-button", fichaVisivel && "ibx-ativo")}
            onClick={onAlternarFicha}
            aria-label={t("Informações do contato")}
            aria-pressed={fichaVisivel}
            title={t("Informações do contato")}
            data-testid="alternar-ficha"
          >
            <SidebarSimple className="ibx-icon" mirrored aria-hidden />
          </button>
        )}
      </div>
    </div>
    {/* O aviso pertence à operação automática: sem esta marca, a conversa em
        que o robô está calado tem a mesma cara de uma conversa normal. O
        testid é contrato: `escalacao-ciclo.spec.ts` o lê. */}
    {motivo !== null && (
      <div className="ibx-motivo">
        <Badge
          variant="outline"
          className="h-4 w-fit max-w-full truncate px-1.5 text-[10px]"
          title={t(ROTULO_DO_MOTIVO[motivo])}
          data-testid="badge-atendimento-humano"
        >
          {t(ROTULO_DO_MOTIVO[motivo])}
        </Badge>
      </div>
    )}
    <VideoCallButton
      conversationId={conversation.id}
      provider={conversation.channel_sessions?.provider ?? null}
      lastInboundAt={conversation.last_inbound_at}
      bloqueio={motivoDoContato(c, t)}
      encerrada={status === "closed"}
      controle={{ aberto: videoAberto, onAbertoChange: setVideoAberto }}
    />
      <ReassignDialog
        conversationId={conversation.id}
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        numero={
          onAbrirConversa && c?.id
            ? {
                contactId: c.id,
                contactPhone: c.phone_number ?? null,
                channelSessionId: conversation.channel_session_id,
                onAbrirConversa,
              }
            : undefined
        }
      />
      <AlertDialog open={confirmFecharOpen} onOpenChange={setConfirmFecharOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Fechar esta conversa?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O atendimento é encerrado. Se o cliente escrever de novo, você pode reabrir.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                close.mutate({
                  conversation_id: conversation.id,
                  expected_revision: conversation.service_revision,
                })
              }
            >
              {t("Fechar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* A confirmação diz o que ACONTECE ao marcar: a conversa fecha e sai do
          atendente, e o contato fica inutilizado para envio — sem apagar nada.
          Desmarcar é direto no botão porque só relista o que já está lá. */}
      <AlertDialog open={confirmPessoalOpen} onOpenChange={setConfirmPessoalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Marcar este contato como pessoal?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A conversa sai do inbox e o contato fica fora da operação: sem IA, sem follow-up, sem campanha e sem envio. O histórico continua no banco e volta à vista ao desmarcar; follow-ups e campanhas cancelados não voltam.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => marcarPessoal.mutate()}>
              {t("Marcar como pessoal")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
