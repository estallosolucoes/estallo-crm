"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { PushPin, Robot } from "@/lib/ui/icons";
import { AckIndicator } from "@/components/inbox/AckIndicator";
import { ChannelLogo } from "@/components/inbox/ChannelLogo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { AcoesDaConversa } from "@/components/inbox/AcoesDaConversa";
import {
  comandoDaConversa,
  ROTULO_DO_COMANDO,
  STATUS_ENCERRADOS,
} from "@/lib/inbox/comando-da-conversa";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { FormatacaoWhatsApp } from "@/lib/mensagens/formatacao-whatsapp";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /**
   * Mostrar POR ONDE a conversa entrou.
   *
   * Só com mais de um número conectado. Com um só, o rótulo seria a mesma
   * palavra em toda linha da lista — ruído que ensina o olho a ignorar a área
   * onde vivem os avisos que importam (bloqueado, tags).
   */
  mostrarCanal?: boolean;
  /**
   * Mostrar QUEM está no comando de cada conversa.
   *
   * Mesma regra do canal, e pelo mesmo motivo: só quando o rótulo DISCRIMINA. Nas
   * abas "Fila" (todas sem dono), "Minhas" (todas do mesmo dono) e "IA" o badge
   * seria a mesma palavra em toda linha — ruído que ensina o olho a ignorar a
   * área onde vivem os avisos que importam. Quem decide é a lista, que é quem
   * sabe quantos donos distintos ela tem.
   */
  /** Sem efeito desde 16/10/2026: o dono aparece na linha de operação ("Com Fulano"). */
  mostrarAtendente?: boolean;
  /**
   * Mostrar o ícone de robô na prévia da mensagem, quando quem manda é o
   * automático. Mesma regra dos dois badges acima: só quando DISCRIMINA. Na
   * aba "Automático" toda linha já é robô, e o ícone repetido em cada uma vira
   * ruído. Ausente ou `true` = mostra (comportamento anterior, seguro para o
   * teste que não passa esta prop).
   */
  mostrarAutomatico?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
  /** Fecha a conversa aberta (o menu da linha pede ao marcar como não lida ou apagar). */
  onFecharConversa?: () => void;
}

function initials(name: string | null | undefined, fallback: string): string {
  const v = (name ?? "").trim();
  if (!v) return fallback.slice(0, 2).toUpperCase();
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 2).toUpperCase();
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

/**
 * O tom pastel do avatar, fixo por pessoa (o modelo tem seis). A cor é
 * decoração: sai do nome, então a mesma pessoa tem o mesmo tom em toda tela.
 */
const TONS_DO_AVATAR = [
  "ibx-tom-areia",
  "ibx-tom-rosa",
  "ibx-tom-salvia",
  "ibx-tom-lilas",
  "ibx-tom-ceu",
  "ibx-tom-neutro",
];
export function corDoAvatar(nome: string): string {
  let h = 0;
  for (let i = 0; i < nome.length; i += 1) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return TONS_DO_AVATAR[h % TONS_DO_AVATAR.length]!;
}

/**
 * QUEM ATENDE, EM 20px — no lugar do texto "Com <nome>" (pedido de 17/10/2026).
 *
 * O texto disputava a atenção com a prévia da mensagem logo acima, nos dois
 * temas. O avatar diz a mesma coisa sem competir: a foto do perfil do
 * atendente, ou as iniciais, e o nome no passar do mouse (e para leitor de
 * tela). A foto vem da lista de membros, que o cabeçalho já carrega — uma
 * leitura por tela, não por linha.
 */
function AvatarDoAtendente({ userId, nome }: { userId: string | null; nome: string }) {
  const membros = useAssignableMembers(true);
  const foto = membros.data?.find((m) => m.user_id === userId)?.avatar_url ?? null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ibx-attendant" role="img" aria-label={nome}>
            <Avatar className="size-5">
              {foto ? <AvatarImage src={foto} alt="" className="object-cover" /> : null}
              <AvatarFallback className={cn("text-[9px] font-semibold", corDoAvatar(nome))}>
                {initials(nome, "?")}
              </AvatarFallback>
            </Avatar>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{nome}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  mostrarCanal,
  mostrarAutomatico = true,
  automaticoDaOrg,
  onFecharConversa,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c, t);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || t("Sem mensagens");
  // A última mensagem é NOSSA quando a saída é a mais recente — a mesma régua do
  // `status_do_chat`. É o que põe o tique antes da prévia, como no WhatsApp.
  const ultimaFoiDeSaida =
    !!conversation.last_outbound_at &&
    (!conversation.last_inbound_at || conversation.last_outbound_at >= conversation.last_inbound_at);
  // O canto acompanha a última atividade, a mesma data da ordenação da lista.
  const time = relativeTime(conversation.last_message_at, localeDaData);
  const unread = conversation.unread_count_for_assignee ?? 0;

  /**
   * Quem manda, pela MESMA regra do cabeçalho.
   *
   * `status === 'ai_handling'` era um proxy ruim e foi medido: o único escritor
   * desse status em produção é o botão "Devolver ao automático", então o ícone de
   * robô aparecia só em conversa que já tinha sido escalada E devolvida — nunca
   * na que o automático atendeu do começo ao fim, que é a maioria.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    last_handoff_reason: conversation.last_handoff_reason ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    is_group: conversation.is_group ?? false,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  // A cor sozinha não se explica: quem não decorou a tabela perguntava o que
  // cada bolinha queria dizer. A palavra é a de ROTULO_DO_COMANDO, o rótulo que
  // o produto já define para cada estado, no passar do mouse e no leitor de
  // tela — antes ela era `aria-hidden`.
  //
  // Encerrada vence `humano` só na PALAVRA. Fechar não solta o dono
  // (`fn_service_status`), e `comandoDaConversa` segue dizendo `humano` para
  // nomear quem atendeu — a cor acompanha isso e fica como estava. Mas escrever
  // "Em atendimento" numa conversa fechada afirmaria no presente um atendimento
  // que acabou.
  const rotuloDoComando = t(
    STATUS_ENCERRADOS.has(conversation.status)
      ? ROTULO_DO_COMANDO.encerrada
      : (ROTULO_DO_COMANDO[comando.quem] ?? ROTULO_DO_COMANDO.ninguem),
  );

  // QUEM MANDA ESTA CONVERSA — o número DA EMPRESA por onde ela chegou, não o
  // do cliente. Com dois canais é o que decide o tom da resposta e qual número
  // a pessoa vê respondendo.
  //
  // #2383: quando o canal tem nome ou número, o texto é o MESMO do card da tela
  // de canais (`/app/connections`), com o nome amigável na frente — antes o
  // número vencia o nome, e um canal chamado "Peças" saía na lista como o
  // número cru. Sem canal associado (grupo, conversa sem sessão, não-WA) e sem
  // nome E sem número o badge continua não existindo, como estava.
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = rotuloDoCanalDaConversa(canal, t);

  // Conversa com atendente (e aberta): o avatar entra na linha dos selos.
  const atendente =
    comando.quem === "humano" && !STATUS_ENCERRADOS.has(conversation.status)
      ? (comando.nome ?? t("Atendente"))
      : null;

  const temSelos =
    atendente != null ||
    visibleTags.length > 0 ||
    (mostrarCanal && rotuloCanal != null) ||
    Boolean(c?.is_blocked) ||
    Boolean(c?.is_anonymized);

  // A linha do modelo do dono (16/10/2026): nome + hora + setinha em cima, a
  // prévia no meio e a OPERAÇÃO embaixo ("1º na fila · Espera de 21h"). A
  // espera saiu do canto direito — ali agora mora a hora da última mensagem e
  // a setinha do menu, como no modelo.
  const operacao = STATUS_ENCERRADOS.has(conversation.status) ? (
    <span>{t("Conversa fechada")}</span>
  ) : isAi ? (
    <>
      <Robot size={11} weight="duotone" className="ibx-icon" aria-hidden />
      <span>{t("Atendimento automático")}</span>
    </>
  ) : comando.quem === "humano" ? null : (
    <span>{rotuloDoComando}</span>
  );

  return (
    <div
      className={cn(
        "ibx-conversation",
        isSelected && "ibx-selected",
        unread > 0 && "ibx-is-unread",
      )}
    >
      <button
        type="button"
        data-conversation-id={conversation.id}
        onClick={() => onSelect(conversation.id)}
        className="ibx-open-conversation"
        aria-current={isSelected ? "true" : undefined}
      >
        <span className="ibx-avatar">
          <Avatar className="ibx-avatar-face">
            {/* Só monta a <img> quando existe arquivo: sem isso o browser pediria
                a rota para TODO contato da lista e levaria 404 em cada um sem
                foto — que é a maioria. O AvatarFallback do Radix já cobre o caso
                de a imagem não carregar, então as iniciais nunca somem. */}
            {c?.avatar_storage_path && !c?.is_anonymized ? (
              <AvatarImage
                src={`/api/v1/contacts/${c.id}/avatar`}
                alt=""
                className="object-cover"
              />
            ) : null}
            <AvatarFallback className={cn("font-medium text-[inherit]", corDoAvatar(displayName))}>
              {initials(displayName, phoneFallback)}
            </AvatarFallback>
          </Avatar>
          {/* Quem manda, para leitor de tela e no passar do mouse: o desenho do
              modelo não tem a bolinha colorida, mas a informação continua. */}
          <span
            className="sr-only"
            role="img"
            aria-label={rotuloDoComando}
            title={rotuloDoComando}
          />
          <span className="ibx-channel-badge">
            <ChannelLogo channel={canal} size={11} />
          </span>
        </span>

        <span className="ibx-contact-copy">
          <span className="ibx-contact-name-row">
            <span
              className={cn(
                "ibx-contact-name",
                c?.is_anonymized && "font-normal text-text-muted italic",
              )}
            >
              {displayName}
            </span>
            {conversation.fixada && (
              <PushPin
                size={11}
                weight="fill"
                className="ibx-pin-indicator"
                aria-label={t("Conversa fixada")}
              />
            )}
            {/*
              A ETIQUETA "GRUPO", ao lado do nome.
              `conversations.is_group` já chega no SELECT do handler (schema
              original) — sem este selo, a lista não distingue um grupo de uma
              conversa individual até abrir a conversa e ver vários remetentes
              na mesma linha do tempo (ver `MessageBubble`, que mostra QUEM
              mandou cada mensagem dentro do grupo).
            */}
            {conversation.is_group && (
              <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                {t("Grupo")}
              </Badge>
            )}
          </span>
          <span className="ibx-message-preview">
            {isAi && mostrarAutomatico ? (
              <Robot size={12} weight="duotone" className="mr-1 inline align-[-2px]" aria-hidden />
            ) : null}
            {ultimaFoiDeSaida ? (
              <span className="mr-1 inline-flex align-[-2px]">
                {/* Sem status conhecido (resposta antiga ou envio em curso), o ✓ simples. */}
                <AckIndicator status={conversation.ultimo_status_de_saida ?? "sent"} t={t} />
              </span>
            ) : null}
            <FormatacaoWhatsApp texto={preview} modo="linha" />
          </span>
          {operacao && <span className="ibx-operational">{operacao}</span>}

          {temSelos && (
            <span className="ibx-badges">
              {atendente && (
                <AvatarDoAtendente userId={conversation.assigned_to_user_id ?? null} nome={atendente} />
              )}
              {visibleTags.map((t) => (
                <ChipDeEtiqueta
                  key={t}
                  tag={t}
                  entidade="contact"
                  className="h-4 px-1.5 text-[10px]"
                />
              ))}
              {overflow > 0 && <span className="text-[10px] text-text-muted">+{overflow}</span>}
              {/* #2383: `min-w-0` + `max-w` + `truncate` — o mesmo tratamento do
                  badge do cabeçalho. O `title` devolve o texto inteiro. */}
              {mostrarCanal && rotuloCanal && (
                <Badge
                  variant="outline"
                  className="h-4 max-w-[9rem] min-w-0 gap-1 truncate px-1.5 text-[10px] font-normal text-text-muted"
                  title={`${t("Entrou por")} ${rotuloCanal}`}
                >
                  <span className="truncate">{rotuloCanal}</span>
                </Badge>
              )}
              {c?.is_blocked && (
                <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                  {t("Bloqueado")}
                </Badge>
              )}
              {c?.is_anonymized && (
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {t("Anonimizado")}
                </Badge>
              )}
            </span>
          )}
        </span>
      </button>
      <span className="ibx-row-time">{time}</span>
      <AcoesDaConversa
        conversationId={conversation.id}
        nome={displayName}
        fixada={conversation.fixada === true}
        aberta={isSelected}
        onFecharConversa={onFecharConversa}
      />
      {unread > 0 && (
        <span className="ibx-unread-count" aria-label={`${unread} ${t("não lidas")}`}>
          {unread}
        </span>
      )}
    </div>
  );
}
