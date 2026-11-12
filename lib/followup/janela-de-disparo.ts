import type { SupabaseClient } from "@supabase/supabase-js";

import { proximaAberturaDoFollowup } from "@/lib/agent-engine/agent/janela-de-followup";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/**
 * A faixa de horário PRÓPRIA do follow-up, no atalho INLINE (`enviarTextoFixoPendente` — o "sem cron e sem
 * agent-worker"). Esse atalho chama `sendMessageHandler` direto e por isso bypassava `executarTurnoDoAgente` e a faixa
 * que o turno aplica antes de falar com o cliente (`ai_agent_versions.followup.send_window`, no fuso da ORGANIZAÇÃO —
 * a faixa é do módulo de agentes). Medido na issue: 8 envios de um mesmo fluxo entre 01h18 e 05h31 de Brasília.
 *
 * Não existe mais janela de horário do CANAL: o único horário que vale é o que o agente declara.
 *
 * O motivo é o MESMO código do caminho do worker (`followup_send_window`) para o dossiê ter um vocabulário só.
 *
 * Falha FECHADA na leitura da faixa (inscrição, agente, versão, fuso da org): erro de banco SOBE (o job volta pra
 * `pending`) — follow-up é contato proativo, e se não dá para saber se o operador autorizou este horário é mais
 * seguro tentar de novo do que mandar fora da faixa. Sem agente/versão publicada no enrollment (dado legado) a regra
 * não existe e o envio segue, como `followupPublicadoDoEnrollment` já faz no worker.
 */
export interface AdiamentoPorJanela {
  /** Instante da próxima abertura — vira `run_after` do job e `until` do enrollment. */
  until: Date;
  /** `followup_send_window` (faixa do agente). */
  reason: string;
}

export interface EntradaDaJanela {
  organizationId: string;
  enrollmentId: string;
  /** Injetável para teste — o default é o relógio real. */
  agora?: Date;
}

/**
 * A configuração PUBLICADA do follow-up do agente pinado no enrollment — o
 * espelho em Supabase de `followupPublicadoDoEnrollment`
 * (`lib/agent-engine/agent/janela-de-followup.ts`, que fala `pg`): as MESMAS
 * três leituras, com o mesmo desfecho `null` quando agent/version não existe.
 */
async function followupPublicado(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentId: string,
): Promise<unknown | null> {
  const { data: inscricao, error: falhaInscricao } = await admin
    .from("followup_enrollments")
    .select("agent_id")
    .eq("organization_id", organizationId)
    .eq("id", enrollmentId)
    .maybeSingle();
  if (falhaInscricao) throw new Error(falhaInscricao.message);
  const agentId = (inscricao as { agent_id?: string | null } | null)?.agent_id;
  if (typeof agentId !== "string" || agentId === "") return null;

  const { data: agente, error: falhaAgente } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("organization_id", organizationId)
    .eq("id", agentId)
    .maybeSingle();
  if (falhaAgente) throw new Error(falhaAgente.message);
  const versionId = (agente as { published_version_id?: string | null } | null)?.published_version_id;
  if (typeof versionId !== "string" || versionId === "") return null;

  const { data: versao, error: falhaVersao } = await admin
    .from("ai_agent_versions")
    .select("followup")
    .eq("organization_id", organizationId)
    .eq("id", versionId)
    .maybeSingle();
  if (falhaVersao) throw new Error(falhaVersao.message);
  return (versao as { followup?: unknown } | null)?.followup ?? null;
}

/**
 * `null` = pode enviar AGORA. Caso contrário, o instante da próxima abertura da faixa do agente.
 */
export async function decidirAdiamentoPorJanela(
  admin: SupabaseClient,
  entrada: EntradaDaJanela,
): Promise<AdiamentoPorJanela | null> {
  const agora = entrada.agora ?? new Date();
  const followup = await followupPublicado(admin, entrada.organizationId, entrada.enrollmentId);
  if (followup === null) return null;

  const { data: org, error: falhaOrg } = await admin
    .from("organizations")
    .select("timezone")
    .eq("id", entrada.organizationId)
    .maybeSingle();
  if (falhaOrg) throw new Error(falhaOrg.message);
  const fuso = fusoUtilizavel((org as { timezone?: string | null } | null)?.timezone);

  const abertura = proximaAberturaDoFollowup(followup, fuso, agora);
  return abertura === null ? null : { until: abertura, reason: "followup_send_window" };
}
