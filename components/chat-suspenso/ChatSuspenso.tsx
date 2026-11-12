"use client";

import "@/components/inbox/inbox.css";
import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { buscarConversa, useConversation } from "@/hooks/inbox/useConversation";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import { useEstadoDoEnvio } from "@/hooks/inbox/useEstadoDoEnvio";
import { alinharFioComAPrevia } from "@/hooks/inbox/recargaDasConversas";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useVoiceCall } from "@/components/voice/VoiceCallContext";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { corDoAvatar } from "@/components/inbox/ConversationListItem";
import { RetentionNotice } from "@/components/inbox/RetentionNotice";
import { JanelaFechadaAviso } from "@/components/inbox/JanelaFechadaAviso";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowSquareOut, CaretDown, ChatCircle, Check, Minus, X } from "@/lib/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useContinuarPorOutroNumero } from "@/hooks/inbox/useContinuarPorOutroNumero";
import { outrosNumerosDoContato } from "@/lib/inbox/outros-numeros";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { cn } from "@/lib/utils";
import type { Message } from "@/lib/types/messaging";
import { useChatSuspenso, type ChatSuspensoApi } from "./ChatSuspensoContext";

// O fio e o composer são os do Inbox — não uma segunda implementação. Carregados
// sob demanda: quem nunca abre um chat suspenso não paga por eles em toda tela.
const ChatThread = dynamic(() => import("@/components/inbox/ChatThread").then((m) => m.ChatThread));
const Composer = dynamic(() => import("@/components/inbox/Composer").then((m) => m.Composer));

/**
 * O chat suspenso NÃO reserva rodapé: ele flutua por cima do conteúdo, como um
 * diálogo. A primeira versão registrava a peça no contrato do rodapé, e a
 * reserva encolhia a tela de baixo — no funil virava uma faixa vazia na frente
 * dos cards (relatado em 17/10/2026).
 */
/** Com chamada de voz no ar o canto de baixo é do painel da chamada: o chat sobe. */
const ACIMA_DA_CHAMADA = 96;

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return `${partes[0]![0] ?? ""}${partes[partes.length - 1]![0] ?? ""}`.toUpperCase();
}

function AvatarDoContato({
  conversa,
  nome,
  className,
}: {
  conversa: ConversationWithContact | undefined;
  nome: string;
  className?: string;
}) {
  const c = conversa?.contacts;
  return (
    <Avatar className={className}>
      {c?.avatar_storage_path && !c.is_anonymized ? (
        <AvatarImage src={`/api/v1/contacts/${c.id}/avatar`} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className={cn("text-xs font-semibold", corDoAvatar(nome))}>
        {iniciais(nome)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * CHATS SUSPENSOS — conversar com o contato sem sair do funil ou das tarefas.
 *
 * Uma janela compacta no canto inferior direito, com os MESMOS fio e composer do
 * Inbox (mesmas mensagens, mesma ordem, mesmas regras de envio, mesmo tempo
 * real). Vários contatos ficam como avatares empilhados à esquerda da janela;
 * só um fica expandido. Minimizado, vira uma bolha com o total de não lidas.
 *
 * No próprio Inbox não aparece: a tela já é o chat. O estado continua guardado
 * e volta ao sair de lá.
 */
export function ChatSuspenso() {
  const chat = useChatSuspenso();
  const rota = usePathname();
  // Sem chat aberto nada é lido — nem a sessão: a casca monta isto em toda tela.
  if (!chat || chat.abertos.length === 0) return null;
  if (rota?.startsWith("/app/inbox")) return null;
  return <Doca chat={chat} />;
}

function Doca({ chat }: { chat: ChatSuspensoApi }) {
  const t = useT();
  const orgId = useAuth().activeOrg?.orgId ?? null;
  const qc = useQueryClient();
  const { call, minha } = useVoiceCall();
  const elevado = Boolean(minha && call && call.status !== "ended");
  const { abertos, ativo, minimizado } = chat;

  // Uma busca por conversa aberta — a MESMA chave do Inbox, então os dois
  // compartilham o dado (e o que um atualiza o outro vê).
  const conversas = useQueries({
    queries: abertos.map((id) => ({
      queryKey: ["conversation", id],
      queryFn: () => buscarConversa(id),
      retry: false,
    })),
    combine: (rs) => rs.map((r) => r.data),
  });
  const porId = new Map(abertos.map((id, i) => [id, conversas[i]]));
  const naoLidas = (id: string) => porId.get(id)?.unread_count_for_assignee ?? 0;
  const totalNaoLidas = abertos.reduce((soma, id) => soma + naoLidas(id), 0);

  // Um canal de conversas da org enquanto há chat aberto: contador de não lidas,
  // status e prévia acompanham sem polling, e o fio é relido se ficou para trás.
  const aoMudar = useCallback(
    (payload: unknown) => {
      alinharFioComAPrevia(qc, payload);
      const id = (payload as { new?: { id?: unknown } } | null)?.new?.id;
      if (typeof id === "string" && abertos.includes(id)) {
        void qc.invalidateQueries({ queryKey: ["conversation", id] });
      }
    },
    [qc, abertos],
  );
  useRealtimeChannel({
    name: orgId ? `chat-suspenso-${orgId}` : "chat-suspenso-desligado",
    postgresChanges: orgId
      ? {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange: aoMudar,
    enabled: !!orgId,
  });

  const nomeDe = (id: string) => rotuloDoContato(porId.get(id)?.contacts ?? null, t);

  return (
    <aside
      aria-label={t("Chats suspensos")}
      style={{ bottom: elevado ? ACIMA_DA_CHAMADA : "var(--chat-suspenso-base)" }}
      className="ibx fixed right-2 z-40 flex items-end gap-2 [--chat-suspenso-base:5rem] md:right-4 md:[--chat-suspenso-base:1rem]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !minimizado) {
          e.stopPropagation();
          chat.minimizar();
        }
      }}
    >
      {/* O trilho: um avatar por contato aberto, empilhados. */}
      {!minimizado && (
        <TooltipProvider delayDuration={200}>
          <nav
            aria-label={t("Conversas abertas")}
            // `p-2` e canto `rounded-3xl` (não `rounded-full`): o X de fechar de
            // cada avatar sobra para fora do avatar, e com o canto em meia-lua
            // e pouco respiro a rolagem do trilho o cortava.
            className="chat-suspenso-entrada flex max-h-[min(558px,calc(100dvh-7rem))] flex-col gap-2.5 overflow-y-auto rounded-3xl border border-border bg-background/90 p-2 shadow-lg backdrop-blur-sm"
          >
            {abertos.map((id) => (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <span className="group relative">
                    <button
                      type="button"
                      onClick={() => chat.alternar(id)}
                      aria-label={nomeDe(id)}
                      aria-current={id === ativo ? "true" : undefined}
                      className={cn(
                        "block rounded-full transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2",
                        id === ativo && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                      )}
                    >
                      <AvatarDoContato conversa={porId.get(id)} nome={nomeDe(id)} className="size-10" />
                    </button>
                    {naoLidas(id) > 0 && id !== ativo && (
                      <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground ring-2 ring-background">
                        {naoLidas(id)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => chat.fechar(id)}
                      aria-label={`${t("Fechar chat de")} ${nomeDe(id)}`}
                      className="absolute -left-1 -top-1 z-10 hidden size-4 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-background group-focus-within:flex group-hover:flex"
                    >
                      <X size={10} weight="bold" aria-hidden />
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">{nomeDe(id)}</TooltipContent>
              </Tooltip>
            ))}
          </nav>
        </TooltipProvider>
      )}

      {/* A janela fica SEMPRE montada, inclusive minimizada (invisível e fora
          do fluxo): minimizar não pode perder o texto não enviado, a posição
          de leitura nem o canal de tempo real de cada conversa. */}
      <section
        aria-label={ativo ? `${t("Chat com")} ${nomeDe(ativo)}` : undefined}
        aria-hidden={minimizado}
        className={cn(
          "relative flex h-[min(558px,calc(100dvh-7rem))] w-[min(380px,calc(100vw-5.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl",
          minimizado ? "pointer-events-none invisible absolute right-0" : "chat-suspenso-entrada",
        )}
      >
        {/* Todas as conversas abertas ficam montadas; só a ativa aparece (e só
            ela conta como lida). */}
        {abertos.map((id) => (
          <PainelDaConversa
            key={id}
            conversationId={id}
            visivel={!minimizado && id === ativo}
            aoMinimizar={chat.minimizar}
            aoFecharTodos={chat.fecharTodos}
            aoTrocarDeConversa={(novo) => chat.substituir(id, novo)}
          />
        ))}
      </section>

      {minimizado && (
        <button
          type="button"
          onClick={chat.restaurar}
          aria-label={
            totalNaoLidas > 0
              ? `${t("Abrir chats")} — ${totalNaoLidas} ${t("não lidas")}`
              : t("Abrir chats")
          }
          className="chat-suspenso-entrada relative flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:transition-none"
        >
          <ChatCircle size={26} weight="fill" aria-hidden />
          {totalNaoLidas > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground ring-2 ring-background">
              {totalNaoLidas > 99 ? "99+" : totalNaoLidas}
            </span>
          )}
        </button>
      )}
    </aside>
  );
}

function PainelDaConversa({
  conversationId,
  visivel,
  aoMinimizar,
  aoFecharTodos,
  aoTrocarDeConversa,
}: {
  conversationId: string;
  visivel: boolean;
  aoMinimizar: () => void;
  aoFecharTodos: () => void;
  aoTrocarDeConversa: (conversationId: string) => void;
}) {
  const t = useT();
  const consulta = useConversation(conversationId, true);
  const conversa = consulta.data ?? null;
  const [respondendo, setRespondendo] = useState<Message | null>(null);
  const { motivoDaJanela, blockedReason } = useEstadoDoEnvio(conversa);
  // Minimizada ou atrás de outra, a conversa NÃO é lida: só a que está à vista.
  useMarkAsRead(visivel && conversa ? conversationId : null, conversa?.unread_count_for_assignee ?? 0);
  const nome = rotuloDoContato(conversa?.contacts ?? null, t);

  return (
    <div
      aria-hidden={!visivel}
      // `invisible` e não `hidden`: com `display: none` o navegador zera a
      // rolagem do fio, e voltar à conversa a devolveria ao topo.
      className={cn(
        "absolute inset-0 flex flex-col",
        visivel ? "visible" : "pointer-events-none invisible",
      )}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-3 py-2.5">
        {conversa?.contact_id ? (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Link
              href={`/app/contacts/${conversa.contact_id}`}
              className="shrink-0 rounded-full focus-visible:outline-2"
              title={t("Abrir o cadastro do contato")}
              aria-label={`${t("Abrir o cadastro do contato")}: ${nome}`}
            >
              <AvatarDoContato conversa={conversa} nome={nome} className="size-9" />
            </Link>
            <span className="block min-w-0">
              <Link
                href={`/app/contacts/${conversa.contact_id}`}
                className="block rounded-sm focus-visible:outline-2"
                title={t("Abrir o cadastro do contato")}
              >
                {/* `h2`: o título usa a fonte de títulos do sistema (Sora). */}
                <h2 className="truncate text-sm font-semibold text-foreground hover:underline">
                  {nome}
                </h2>
              </Link>
              <SeletorDeInstancia conversa={conversa} aoTrocar={aoTrocarDeConversa} />
            </span>
          </div>
        ) : (
          <span className="min-w-0 flex-1">
            <Skeleton className="h-4 w-32" />
          </span>
        )}
        <Button asChild size="icon" variant="ghost" className="size-8">
          <Link
            href={`/app/inbox?id=${conversationId}`}
            aria-label={t("Abrir no Inbox")}
            title={t("Abrir no Inbox")}
          >
            <ArrowSquareOut size={18} aria-hidden />
          </Link>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t("Minimizar chat")}
          title={t("Minimizar chat")}
          onClick={aoMinimizar}
        >
          <Minus size={18} aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          // Fecha TODOS: cada conversa já tem o seu X no avatar do trilho.
          aria-label={t("Fechar todos os chats")}
          title={t("Fechar todos os chats")}
          onClick={aoFecharTodos}
        >
          <X size={18} aria-hidden />
        </Button>
      </header>

      {consulta.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p role="alert">{t("Conversa não encontrada ou fora do seu acesso.")}</p>
          <Button variant="outline" size="sm" onClick={() => void consulta.refetch()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : !conversa ? (
        <div className="space-y-3 p-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-2/3" />
          ))}
        </div>
      ) : (
        <OpenConversationProvider conversationId={visivel ? conversationId : null}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatThread
              conversationId={conversationId}
              provider={conversa.channel_sessions?.provider ?? null}
              onResponder={setRespondendo}
              dono={{
                userId: conversa.assigned_to_user_id ?? null,
                nome: conversa.assigned_to_user_name ?? null,
              }}
              contatoId={conversa.contacts?.id ?? null}
            />
          </div>
          {/* Só os avisos rolam. O Composer fica FORA do `overflow-y-auto`: o menu
              de respostas rápidas ("/") e o de menções são `absolute` acima dele,
              e dentro de um contêiner com rolagem eram cortados (30/10/2026). */}
          <div className="max-h-[35%] shrink-0 overflow-y-auto">
            <RetentionNotice conversationId={conversationId} />
            {motivoDaJanela && (
              <JanelaFechadaAviso
                conversationId={conversationId}
                provider={conversa.channel_sessions?.provider ?? null}
                motivo={motivoDaJanela}
              />
            )}
          </div>
          <div className="shrink-0">
            <Composer
              conversationId={conversationId}
              active={visivel}
              compacto
              blockedReason={blockedReason}
              janelaFechada={motivoDaJanela}
              contactName={conversa.contacts?.name ?? null}
              contactDisplayName={conversa.contacts?.display_name}
              respondendo={respondendo}
              onCancelarResposta={() => setRespondendo(null)}
              currentContactId={conversa.contact_id}
            />
          </div>
        </OpenConversationProvider>
      )}
    </div>
  );
}

/**
 * A INSTÂNCIA POR ONDE A CONVERSA ANDA — e a troca para outra.
 *
 * Abaixo do nome vai o nome da instância conectada (não "WhatsApp"). Trocar é
 * o mesmo "continuar pelo outro número" do Transferir do Inbox
 * (`useContinuarPorOutroNumero`): abre — ou reabre — a conversa do contato no
 * outro número e a assume. A conversa nova entra no lugar da atual no chat.
 * Instância fora do ar aparece desabilitada, dizendo por quê.
 */
function SeletorDeInstancia({
  conversa,
  aoTrocar,
}: {
  conversa: ConversationWithContact;
  aoTrocar: (conversationId: string) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const sessoes = useChannelSessions({ enabled: aberto });
  const continuar = useContinuarPorOutroNumero();
  const atual = conversa.channel_sessions;
  const rotulo = atual?.display_name || atual?.phone_number || "WhatsApp";
  const outras = outrosNumerosDoContato(sessoes.data, conversa.channel_session_id ?? "");

  return (
    <DropdownMenu open={aberto} onOpenChange={setAberto}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={continuar.isPending}
          className="flex max-w-full items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 disabled:opacity-60"
          aria-label={`${t("Instância")}: ${rotulo}. ${t("Trocar de instância")}`}
        >
          <ChannelLogo channel={atual} size={12} />
          <span className="truncate">{rotulo}</span>
          <CaretDown size={11} aria-hidden className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Conversa e envio")}
        </DropdownMenuLabel>
        <DropdownMenuItem disabled className="gap-2 opacity-100">
          <ChannelLogo channel={atual} size={14} />
          <span className="min-w-0 flex-1 truncate font-medium text-primary">{rotulo}</span>
          <Check size={14} aria-label={t("Instância atual")} className="text-primary" />
        </DropdownMenuItem>
        {outras.map((s) => (
          <DropdownMenuItem
            key={s.id}
            disabled={!s.conectado || !conversa.contact_id}
            className="gap-2"
            onSelect={() =>
              conversa.contact_id &&
              continuar.mutate(
                { contact_id: conversa.contact_id, channel_session_id: s.id },
                { onSuccess: aoTrocar },
              )
            }
          >
            <ChannelLogo channel={{ ...s, provider: s.provider ?? null }} size={14} />
            <span className="min-w-0 flex-1 truncate">{channelLabel(s, t)}</span>
            {!s.conectado && (
              <span className="shrink-0 text-[11px] text-muted-foreground">{t("fora do ar")}</span>
            )}
          </DropdownMenuItem>
        ))}
        {sessoes.isLoading && <DropdownMenuItem disabled>{t("Carregando…")}</DropdownMenuItem>}
        {!sessoes.isLoading && outras.length === 0 && (
          <DropdownMenuItem disabled className="text-xs">
            {t("Nenhuma outra instância com número")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
