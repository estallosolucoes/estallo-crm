/**
 * REINICIAR uma execução: cria uma execução NOVA e independente, desde o gatilho, na MESMA versão do fluxo da original.
 *
 * É uma ação intencional e repete efeitos: como é execução nova, mensagens, tarefas e movimentos de etapa podem
 * acontecer outra vez. Por isso a tela lista os blocos com efeito antes de confirmar. Aqui moram as recusas que não
 * dependem da tela:
 *
 *  - a original precisa ter TERMINADO (concluída, cancelada ou morta). Viva, ela ainda é a dona do contato — o índice
 *    único "um follow-up vivo por contato" recusaria de todo jeito, e recusar antes dá uma mensagem que diz o que fazer;
 *  - uma reexecução anterior ainda viva trava uma segunda (clique duplo, ou duas pessoas ao mesmo tempo);
 *  - o contato não pode estar bloqueado (opt-out) nem anonimizado: corrigir uma falha não autoriza voltar a falar com
 *    quem pediu para parar;
 *  - o fluxo precisa estar ativo, e a versão da original precisa ainda existir e valer.
 *
 * Com `passoAPasso`, a execução nova nasce PAUSADA no gatilho e marcada para ser conduzida bloco a bloco
 * (migration 0714): cada «Executar próximo bloco» roda um bloco e o motor pausa de novo. Os mesmos efeitos podem se
 * repetir — só que um de cada vez, sob o olho de quem conduz.
 *
 * A original NUNCA é alterada: o vínculo mora na linha nova (`source_enrollment_id` + `recovery_kind = 'restart'`).
 * Não emite nenhum evento de gatilho — o início é o do próprio motor, sobre o contato de sempre.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { audit } from "@/lib/audit";
import { flowGraphSchema } from "@/lib/followup/graph-schema";

const TERMINAIS = ["completed", "cancelled", "dead"] as const;

export interface ReiniciarInput {
  organizationId: string;
  enrollmentId: string;
  actorUserId: string;
  requestId: string;
  /** Nasce pausada no gatilho, para o operador executar um bloco por vez. */
  passoAPasso?: boolean;
  /**
   * `retry` (Fase 6) — RECUPERAR a partir da falha: só de execução que morreu; a nova começa NO BLOCO QUE FALHOU, na
   * mesma versão, e herda as saídas da original (os blocos seguintes continuam citando `{{nodes…}}` do que já rodou).
   * Os blocos concluídos NÃO rodam de novo. Efeito com resultado desconhecido no bloco que falhou recusa: sem prova do
   * que aconteceu, refazer pode duplicar (mensagem, tarefa) — isso pede conferência humana, não um botão.
   */
  modo?: "restart" | "retry";
}

export type ReiniciarResultado =
  | { ok: true; enrollment: { id: string; source_enrollment_id: string; status: string; version_id: string } }
  | { ok: false; code: string; message: string; status: number };

const recusa = (code: string, message: string, status: number): ReiniciarResultado => ({
  ok: false,
  code,
  message,
  status,
});

export async function reiniciarExecucao(
  supabase: SupabaseClient,
  input: ReiniciarInput,
): Promise<ReiniciarResultado> {
  const { organizationId, enrollmentId, actorUserId, requestId } = input;
  const passoAPasso = input.passoAPasso === true;
  const modo = input.modo ?? "restart";

  const { data: original, error: origErr } = await supabase
    .from("followup_enrollments")
    .select(
      "id, pointer_id, version_id, contact_id, lead_id, agent_id, status, execution_mode, conversation_id, current_node_id",
    )
    .eq("organization_id", organizationId)
    .eq("id", enrollmentId)
    .maybeSingle();
  if (origErr) return recusa("internal_error", origErr.message, 500);
  if (!original) return recusa("not_found", "Execução não encontrada.", 404);

  if (!(TERMINAIS as readonly string[]).includes(original.status)) {
    return recusa(
      "execucao_ainda_viva",
      "Esta execução ainda está em andamento. Cancele-a ou espere terminar para reiniciar.",
      409,
    );
  }

  if (modo === "retry" && original.status !== "dead") {
    return recusa(
      "execucao_nao_falhou",
      "Só uma execução que parou por falha pode ser recuperada. Para começar de novo, use «Reexecutar».",
      409,
    );
  }
  if (modo === "retry") {
    const { data: duvidosos, error: duvidososErr } = await supabase
      .from("followup_execution_steps")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("enrollment_id", enrollmentId)
      .eq("node_id", original.current_node_id)
      .eq("status", "unknown");
    if (duvidososErr) return recusa("internal_error", duvidososErr.message, 500);
    if ((duvidosos ?? []).length > 0) {
      return recusa(
        "resultado_desconhecido",
        "Não dá para saber se o bloco que falhou chegou a agir (por exemplo, se a mensagem saiu). Confira com o contato antes: recuperar poderia repetir o efeito.",
        409,
      );
    }
  }

  const { data: filhas, error: filhasErr } = await supabase
    .from("followup_enrollments")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("source_enrollment_id", enrollmentId);
  if (filhasErr) return recusa("internal_error", filhasErr.message, 500);
  if ((filhas ?? []).some((f) => !(TERMINAIS as readonly string[]).includes(f.status))) {
    return recusa("reexecucao_em_andamento", "Esta execução já tem uma reexecução em andamento.", 409);
  }

  const { data: pointer, error: pointerErr } = await supabase
    .from("followup_flow_pointers")
    .select("id, status, surface")
    .eq("organization_id", organizationId)
    .eq("id", original.pointer_id)
    .maybeSingle();
  if (pointerErr) return recusa("internal_error", pointerErr.message, 500);
  if (!pointer) return recusa("not_found", "Fluxo não encontrado.", 404);
  if (pointer.surface === "atendimento") {
    return recusa("flow_not_enrollable", "Roteiro de atendimento começa na conversa, não por reinício.", 422);
  }
  if (pointer.status !== "active") {
    return recusa("flow_not_active", "Fluxo não está ativo (precisa estar publicado).", 422);
  }

  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id, is_blocked, is_anonymized")
    .eq("organization_id", organizationId)
    .eq("id", original.contact_id)
    .maybeSingle();
  if (contatoErr) return recusa("internal_error", contatoErr.message, 500);
  if (!contato) return recusa("not_found", "Contato não encontrado.", 404);
  if (contato.is_anonymized) {
    return recusa("contato_anonimizado", "Este contato foi anonimizado: não é possível reiniciar.", 422);
  }
  if (contato.is_blocked) {
    return recusa(
      "contato_bloqueado",
      "Este contato pediu para não receber mensagens. A execução não pode ser reiniciada.",
      422,
    );
  }

  const { data: versao, error: versaoErr } = await supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", original.version_id)
    .maybeSingle();
  if (versaoErr) return recusa("internal_error", versaoErr.message, 500);
  const grafo = versao ? flowGraphSchema.safeParse(versao.graph) : null;
  if (!grafo?.success) {
    return recusa("versao_ilegivel", "A versão do fluxo desta execução não pode mais ser lida.", 422);
  }
  const gatilho = grafo.data.nodes.find((n) => n.type === "trigger");
  if (!gatilho) return recusa("internal_error", "Grafo da versão sem nó trigger.", 500);
  // Recuperar começa no bloco que falhou (o checkpoint da versão original); reiniciar, no gatilho.
  const inicio = modo === "retry" ? grafo.data.nodes.find((n) => n.id === original.current_node_id) : gatilho;
  if (!inicio) return recusa("versao_ilegivel", "O bloco que falhou não existe mais nesta versão.", 422);

  const fronteira = await beginServiceAtOrigin(supabase, organizationId, original.contact_id);

  const { data: criada, error: insErr } = await supabase
    .from("followup_enrollments")
    .insert({
      organization_id: organizationId,
      pointer_id: original.pointer_id,
      version_id: original.version_id,
      contact_id: original.contact_id,
      lead_id: original.lead_id,
      agent_id: original.agent_id,
      execution_mode: original.execution_mode,
      current_node_id: inicio.id,
      ...(passoAPasso
        ? { status: "paused_manual", next_eval_at: null, passo_a_passo: true }
        : { status: "active" }),
      service_boundary: fronteira,
      conversation_id: fronteira.conversation_id,
      source_enrollment_id: enrollmentId,
      recovery_kind: modo,
    })
    .select("id, source_enrollment_id, status, version_id")
    .single();

  if (insErr || !criada) {
    // 23505: o índice "um vivo por contato" — outra execução do mesmo contato começou no meio do caminho.
    if (insErr?.code === "23505") {
      return recusa("conflict", "Este contato já está em um follow-up ativo (1 por lead na organização).", 409);
    }
    return recusa("internal_error", insErr?.message ?? "followup_restart_insert_failed", 500);
  }

  void audit({
    action: modo === "retry" ? "followup_enrollment.recovered" : "followup_enrollment.restarted",
    actorUserId,
    organizationId,
    resourceType: "followup_enrollment",
    resourceId: criada.id,
    requestId,
    metadata: {
      source_enrollment_id: enrollmentId,
      pointer_id: original.pointer_id,
      version_id: original.version_id,
      recovery_kind: modo,
      passo_a_passo: passoAPasso,
      ...(modo === "retry" ? { node_id: inicio.id } : {}),
    },
  });

  return { ok: true, enrollment: criada };
}
