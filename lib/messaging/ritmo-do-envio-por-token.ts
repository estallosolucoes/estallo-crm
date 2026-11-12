/**
 * O ritmo de quem envia pela API com TOKEN — REST (`Bearer dsk_...`) e MCP.
 *
 * ## Por que existe
 *
 * `POST /api/v1/messages` e as ferramentas MCP de envio chamam `sendMessageHandler` direto, sem a cadeia
 * `before_send` (`runBeforeSend`). Pela tela isso é certo: um atendente não digita rápido o bastante para queimar o
 * número. Por token não é: um script ou um agente externo em laço mandava centenas de mensagens seguidas pelo mesmo
 * número, sem intervalo nenhum.
 *
 * ## O que é
 *
 * O ritmo fixo de todo número sem API oficial (`ritmo-entre-envios.ts`: entre 0,3 e 0,8 s). Canal oficial não tem
 * risco de banimento por volume e passa direto. Os vetos de CONTEÚDO (promessa, vocabulário interno, disclosure)
 * ficam de fora de propósito — são para texto escrito pela IA do CRM, e quem chama por token responde pelo que escreve.
 *
 * ## Limite conhecido
 *
 * O estado do ritmo é do processo. O que segura a rajada paralela é o teto de chamadas por token (REST: nesta rota;
 * MCP: `lib/mcp/rate-limit.ts`), não este intervalo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { capabilitiesOf, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { esperarRitmo } from "@/lib/messaging/ritmo-entre-envios";

export interface CanalDaConversa {
  channelSessionId: string;
  provider: string | null;
}

export interface DepsDoRitmo {
  lerCanalDaConversa(organizationId: string, conversationId: string): Promise<CanalDaConversa | null>;
  lerCanalDaSessao?(organizationId: string, channelSessionId: string): Promise<CanalDaConversa | null>;
  /** Espera o ritmo fixo do número. Injetável para o teste não dormir. */
  esperar(channelSessionId: string): Promise<void>;
}

/** Entrada aceita por `segurarEnvioPorToken`: por conversa existente ou direto pela sessão do canal. */
export type EntradaDoFreio =
  | { organizationId: string; conversationId: string; requestId: string }
  | { organizationId: string; channelSessionId: string; requestId: string };

function temRiscoDeBan(provider: string | null): boolean {
  try {
    return capabilitiesOf((provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider).banRisk;
  } catch {
    // Provider fora da matriz: falha FECHADA. Errar para "sem risco" desarmaria o ritmo num número que pode ser banido.
    return true;
  }
}

/**
 * Segura o envio até o ritmo do número permitir. Não há o que frear quando o canal não tem risco de ban, ou quando a
 * conversa não é desta organização — aí quem responde é o handler, com o 404 dele.
 */
export async function segurarEnvioPorToken(deps: DepsDoRitmo, entrada: EntradaDoFreio): Promise<void> {
  const canal =
    "channelSessionId" in entrada
      ? await (deps.lerCanalDaSessao
          ? deps.lerCanalDaSessao(entrada.organizationId, entrada.channelSessionId)
          : null)
      : await deps.lerCanalDaConversa(entrada.organizationId, entrada.conversationId);
  if (!canal || !temRiscoDeBan(canal.provider)) return;
  await deps.esperar(canal.channelSessionId);
}

/** As dependências reais. `admin` é service role: toda leitura filtra `organization_id`. */
export function depsDoRitmo(admin: SupabaseClient): DepsDoRitmo {
  return {
    async lerCanalDaConversa(organizationId, conversationId) {
      const { data } = await admin
        .from("conversations")
        .select("channel_session_id, channel_sessions:channel_session_id(provider)")
        .eq("organization_id", organizationId)
        .eq("id", conversationId)
        .maybeSingle();
      const linha = data as {
        channel_session_id: string | null;
        channel_sessions: { provider: string | null } | null;
      } | null;
      if (!linha?.channel_session_id) return null;
      return {
        channelSessionId: linha.channel_session_id,
        provider: linha.channel_sessions?.provider ?? null,
      };
    },
    async lerCanalDaSessao(organizationId, channelSessionId) {
      const { data } = await admin
        .from("channel_sessions")
        .select("id, provider")
        .eq("organization_id", organizationId)
        .eq("id", channelSessionId)
        .maybeSingle();
      const linha = data as { id: string; provider: string | null } | null;
      if (!linha?.id) return null;
      return {
        channelSessionId: linha.id,
        provider: linha.provider ?? null,
      };
    },
    esperar: esperarRitmo,
  };
}
