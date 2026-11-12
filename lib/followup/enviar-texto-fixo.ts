import {sendWithLedger,supabaseSendLedger} from "@/lib/agent-engine/edge/crm/send-ledger";
import { randomUUID } from "node:crypto";
import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { createSupabaseAdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import { decidirAdiamentoPorJanela } from "@/lib/followup/janela-de-disparo";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "@/lib/followup/turn-bridge";
import { logger } from "@/lib/logger";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { executionContractProblem } from "@/lib/automation/execution-capability";
import { copiarAnexoParaConversa, itemDoFluxoSchema } from "@/lib/agent-engine/agent/anexos-do-fluxo";
import { z } from "zod";

function ponteSupabase(admin: SupabaseClient): TurnBridgeAdminClient {
  const base = createSupabaseAdminClient(admin);
  return {
    ...base,
    async assertFollowupJob(orgId,jobId,enrollmentId,nodeId,claim){
      if(!claim)throw new StaleServiceBoundaryError();
      const held=await admin.rpc("fn_followup_claim_current",{p_org:orgId,p_job:jobId,p_worker:claim.worker_id,p_acquired_at:claim.acquired_at});
      if(held.error)throw held.error;if(!held.data)throw new StaleServiceBoundaryError();
      const {data,error}=await admin.rpc("fn_followup_job_current",{p_org:orgId,p_job:jobId,p_enrollment:enrollmentId,p_node:nodeId});
      if(error) throw error;
      if(!data) throw new StaleServiceBoundaryError();
    },
    async loadEnrollmentById(orgId, id) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("*")
        .eq("id", id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      return data as EnrollmentRow;
    },
  };
}

/**
 * `run_after` é gravado pelo banco em MICROssegundos (`now()`); o relógio do JS só
 * tem MILIssegundos. `lte(run_after, new Date())` trunca o instante atual e deixa
 * invisível o job vencido há menos de 1 ms — medido: 62–80% de perda num
 * `update ... run_after=now()` seguido do filtro, e é o vermelho intermitente de
 * `agenda-presenca-recuperacao.spec.ts:872`. O instante do JS cobre o
 * milissegundo inteiro, então "vencido" é `run_after` antes do FIM dele.
 */
function fimDoMilissegundoCorrente(): string {
  return new Date(Date.now() + 1).toISOString();
}

/** Envia o texto fixo do fluxo neste request — sem cron e sem agent-worker. */
export async function enviarTextoFixoPendente(
  admin: SupabaseClient,
  somenteContactIds?: string[],
): Promise<number> {
  const { data: jobs, error } = await admin
    .from("job_queue")
    .select("id, organization_id, contact_id, payload, attempts, max_attempts")
    .eq("kind", "followup_turn")
    .eq("status", "pending")
    .lt("run_after",fimDoMilissegundoCorrente())
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);

  const workerId=`inline-followup:${randomUUID()}`;
  /**
   * Fecha o job. `adiamento` devolve ele a `pending` apontando `retryAt` (sem
   * gastar tentativa) — é o desfecho de uma espera LEGÍTIMA, não de falha: a
   * janela de disparo do canal/da faixa (#2658) e a proteção de agenda.
   */
  async function settle(org:string,id:string,acquiredAt:string,done:boolean,error?:string,adiamento?:{retryAt:string|null;hold:boolean}){
    const {data:held,error:failure}=await admin.rpc("fn_followup_inline_settle",{p_org:org,p_id:id,p_worker:workerId,p_acquired_at:acquiredAt,p_done:done,p_error:error??null,p_retry_at:adiamento?.retryAt??null,p_hold:adiamento?.hold===true});
    if(failure) throw failure;
    if(!held) throw new StaleServiceBoundaryError();
  }
  let enviados = 0;
  const ponte = ponteSupabase(admin);
  for (const job of jobs ?? []) {
    const payload = (job.payload ?? {}) as FollowupJobRequest["payload"];
    // Um texto fixo é o caso de um item só; o bloco de mensagens traz a lista (`fixed_items`).
    const itensLidos = z.array(itemDoFluxoSchema).min(1).max(10).safeParse(payload.fixed_items);
    const itens: Array<z.infer<typeof itemDoFluxoSchema>> =
      typeof payload.fixed_body === "string" && payload.fixed_body
        ? [{ kind: "text", body: payload.fixed_body }]
        : itensLidos.success
          ? itensLidos.data
          : [];
    const enrollmentId = payload.followup_enrollment_id;
    const nodeId = payload.node_id;
    const contactId = job.contact_id as string | null;
    if (itens.length === 0 || !enrollmentId || !nodeId || !contactId) continue;
    if (somenteContactIds && !somenteContactIds.includes(contactId)) continue;

    const { data: claimed, error: claimErr } = await admin
      .from("job_queue")
      .update({ status: "running",attempts:Number(job.attempts??0)+1,locked_by:workerId,locked_at:new Date().toISOString() })
      .eq("id", job.id)
      .eq("organization_id",job.organization_id)
      .eq("status", "pending")
      .lt("run_after",fimDoMilissegundoCorrente())
      .select("id,locked_by,locked_at")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) continue;
    const jobClaim={worker_id:claimed.locked_by as string,acquired_at:claimed.locked_at as string};

    try {
      const { data: enr, error: enrollmentError } = await admin
        .from("followup_enrollments")
        .select("current_node_id,status,revision,version_id,execution_contract")
        .eq("id", enrollmentId)
        .eq("organization_id", job.organization_id as string)
        .maybeSingle();
      if (enrollmentError) throw new Error(enrollmentError.message);
      if (!enr || enr.current_node_id !== nodeId || !["active","waiting_reply"].includes(enr.status)) {
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }
      const graph = await ponte.loadFlowGraph(job.organization_id, enr.version_id);
      if (!graph) throw new Error("flow_version_not_found");
      const contractProblem = executionContractProblem(enr, graph);
      if (contractProblem) throw new Error(contractProblem);
      const boundary = parseServiceBoundary((job.payload as Record<string, unknown>).service_boundary);
      await assertServiceBoundarySupabase(admin, boundary);
      const conversationId = boundary!.conversation_id;
      // GATE DE ELEGIBILIDADE — este envio inline BYPASSA `executarTurnoDoAgente`
      // (é o atalho "sem cron e sem agent-worker"), então precisa da checagem
      // por conta própria. Mesma regra pura do drain/turno. Canal 'open' → passa.
      // Bloqueio definitivo → o follow-up NÃO sai e o job vira `done`. Erro de
      // leitura → job volta pra `pending` (pode ser transitório) — fail-closed:
      // não envia sem confirmar.
      const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: job.organization_id as string,
        conversationId,
        agora: new Date(),
        ttlMs: ttlDaAutorizacaoMs(process.env),
      });
      if (elegib !== null && !elegib.permite) {
        logger.info("[followup] texto fixo não enviado — conversa não elegível para IA", {
          organization_id: job.organization_id,
          conversation_id: conversationId,
          motivo: elegib.motivo,
        });
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }

      // #2658 — AS DUAS RÉGUAS DE HORÁRIO, TAMBÉM AQUI.
      //
      // Este atalho BYPASSA `executarTurnoDoAgente` e, junto com ele, as duas
      // réguas que o turno aplica antes de falar com o cliente: a janela de
      // DISPARO do canal (a tela de Proteção de envio) e a faixa PRÓPRIA do
      // follow-up (`followup.send_window`). O texto fixo saía de madrugada —
      // medido na issue: 8 envios de um mesmo fluxo entre 01h18 e 05h31 de
      // Brasília, com a janela em 8h–18h, e nenhum `action_deferred` gravado.
      // As duas réguas e os códigos de motivo moram em
      // `lib/followup/janela-de-disparo.ts`; os motivos são os MESMOS do
      // caminho do worker para o dossiê ter um vocabulário só.
      const adiamento = await decidirAdiamentoPorJanela(admin, {
        organizationId: job.organization_id as string,
        enrollmentId,
      });
      if (adiamento !== null) {
        logger.info("[followup] texto fixo adiado — fora da janela de disparo", {
          organization_id: job.organization_id,
          conversation_id: conversationId,
          enrollment_id: enrollmentId,
          motivo: adiamento.reason,
          next_run_at: adiamento.until.toISOString(),
        });
        // O adiamento VOLTA para o enrollment, como no caminho do worker
        // (`followup-turn.ts`): sem o evento `action_deferred` o dead-man lê a
        // espera como worker morto e marca `dead` uma inscrição cujo envio ainda
        // vai sair na abertura. E o MESMO job volta pra `pending` apontando a
        // abertura (hold: sem gastar tentativa) — o envio sai sozinho.
        await completeTurnForEnrollment(
          ponte,
          job.organization_id,
          enrollmentId,
          nodeId,
          { kind: "deferred", until: adiamento.until, reason: adiamento.reason },
          undefined,
          job.id,
          jobClaim,
        );
        await settle(job.organization_id, job.id, jobClaim.acquired_at, false, undefined, {
          retryAt: adiamento.until.toISOString(),
          hold: true,
        });
        continue;
      }

      const proactiveContext={organizationId:job.organization_id as string,contactId,enrollmentId,nodeId,jobId:job.id,jobClaim};
      await assertAgendaEffectSupabase(admin,proactiveContext);
      // Em ordem, parando no primeiro que não saiu: o `seq` (posição do item) é a chave do ledger, e o retry
      // de um job que caiu no meio reenvia só o que falta — os já aceitos voltam como `already_sent`.
      let pulado: string | null = null;
      for (const [i, item] of itens.entries()) {
        const seq = i + 1;
        const midia =
          item.kind === "text"
            ? null
            : await copiarAnexoParaConversa(logger, { orgId: job.organization_id as string, conversationId, path: item.path });
        if (midia && !midia.ok) {
          pulado = midia.motivo;
          break;
        }
        const legenda = item.kind === "text" ? item.body : item.kind === "audio" ? "" : (item.caption ?? "");
        const resultado=await sendWithLedger(supabaseSendLedger(admin),{tenantId:job.organization_id,leadId:contactId,jobId:job.id,seq,body:legenda},async(key,messageId)=>sendMessageHandler(
          admin,
          {organization_id:job.organization_id,actor:{type:"webhook_source",id:enrollmentId},serviceBoundary:boundary,proactiveContext,internalMessageId:messageId,requestId:key},
          item.kind === "text"
            ? {conversation_id:conversationId,type:"text",body:item.body,metadata:{idempotency_key:key}}
            : {
                conversation_id:conversationId,
                type:item.kind,
                media_storage_path:midia!.ok ? midia!.storagePath : "",
                media_mime:item.mime,
                media_size_bytes:item.size_bytes,
                ...(legenda ? {body:legenda} : {}),
                metadata:{idempotency_key:key},
              },
        ));
        if(resultado.kind!=="sent" && resultado.kind!=="already_sent") throw new Error(`message_${resultado.kind}`);
      }
      if (pulado !== null) {
        await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, { kind: "skipped", reason: pulado },undefined,job.id,jobClaim);
        await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
        continue;
      }
      enviados++;
      await completeTurnForEnrollment(ponte, job.organization_id, enrollmentId, nodeId, {
        kind: "sent",
      },undefined,job.id,jobClaim);
      await settle(job.organization_id,job.id,jobClaim.acquired_at,true);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn("[dev.pipeline] envio inline falhou", { error: message });
      let revogado = false;
      if (err instanceof StaleServiceBoundaryError) {
        const {data: fato,error: falhaDeLeitura} = await admin.rpc("fn_autonomous_turn_revoked", {
          p_org: job.organization_id, p_job: job.id,
        });
        if (falhaDeLeitura) throw falhaDeLeitura;
        revogado = fato === true;
      }
      if (err instanceof OrgNaoOperanteError || revogado) {
        // Turno revogado durante pausa/tomada ou suspensão: a inscrição precisa
        // do rastro de descarte para retomar sem falso worker morto.
        const { error: falhaDoDescarte } = await admin.rpc("fn_followup_turno_descartado", { p_org: job.organization_id, p_job: job.id });
        if (falhaDoDescarte) throw falhaDoDescarte;
      }
      await settle(job.organization_id,job.id,jobClaim.acquired_at,err instanceof StaleServiceBoundaryError||err instanceof OrgNaoOperanteError,message,
        err instanceof AgendaDeferredError
          ? { retryAt: err.protection.reavaliar_em ?? null, hold: err.protection.motivo !== "leitura_indisponivel" }
          : undefined);
    }
  }
  return enviados;
}
