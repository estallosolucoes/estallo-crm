"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { estadoDaJanela } from "@/lib/channels/janela";
import { motivoDaJanelaFechada, motivoDoContato } from "@/lib/inbox/motivo-do-envio-bloqueado";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * PODE ENVIAR NESTA CONVERSA? — a mesma resposta no Inbox e no chat suspenso.
 *
 * Saiu do `InboxLayout` quando o chat suspenso nasceu: duas cópias da regra
 * divergem, e a segunda esquece de cobrir o áudio ou o anexo.
 *
 * A janela de 24h fecha o composer, e o motivo DIZ há quanto tempo fechou. Ela
 * vence SOZINHA com a aba aberta: sem o relógio, quem deixa a tela aberta a
 * tarde inteira seguiria com o composer liberado numa conversa que já venceu.
 */
export function useEstadoDoEnvio(conversa: ConversationWithContact | null) {
  const t = useT();
  const { user } = useAuth();
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const relogio = setInterval(() => setAgora(new Date()), 30_000);
    return () => clearInterval(relogio);
  }, []);

  const provider = conversa?.channel_sessions?.provider ?? null;
  const janela = estadoDaJanela(provider, conversa?.last_inbound_at ?? null, agora);
  // Os textos moram em lib/inbox/motivo-do-envio-bloqueado.ts: o "Enviar link"
  // da videochamada desabilita na mesma conversa e mostra o MESMO motivo.
  const motivoDaJanela = motivoDaJanelaFechada(janela, conversa?.channel_sessions?.provider, t);
  const blockedReason =
    user.support?.access_mode === "support_readonly"
      ? "Acompanhamento somente leitura"
      : motivoDoContato(conversa?.contacts, t);

  return { motivoDaJanela, blockedReason, fechada: conversa?.status === "closed" };
}
