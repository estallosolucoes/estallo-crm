import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/leads/[id]/move-pipeline
 *
 * Move o MESMO negócio para uma etapa aberta de OUTRO funil — decisão do
 * Estallo, que substitui a cópia da P-01 (`/clone`, que encerrava a origem e
 * criava outro negócio). O id, a conversa, as tarefas, a timeline e os campos
 * personalizados seguem com ele.
 *
 * As mesmas guardas do `/move`: negócio aberto, etapa de destino aberta (ganho
 * e perda fecham por outros botões), campos obrigatórios do destino, e trava
 * otimista por `expected_updated_at`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  recusaDeCamposObrigatorios,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    stage_id: z.string().uuid(),
    expected_updated_at: z.string().min(1),
    custom_fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;
  const orgId = authz.org.orgId;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Escolha o funil e a etapa de destino."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const supabase = await createClient();
  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  if (lead.status !== "open") {
    return fail("lead_not_open", t("Só um negócio aberto muda de funil."), 422, { requestId });
  }

  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, name, is_won, is_lost, is_archived, crm_pipelines!inner(is_archived)")
    .eq("id", input.stage_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (stageErr) return fail("internal_error", stageErr.message, 500, { requestId });
  const funilArquivado = (stage?.crm_pipelines as { is_archived?: boolean } | null)?.is_archived;
  if (!stage || stage.is_archived || funilArquivado) {
    return fail("not_found", t("Etapa de destino não encontrada."), 404, { requestId });
  }
  if (stage.pipeline_id === lead.pipeline_id) {
    return fail("same_pipeline", t("O negócio já está neste funil."), 422, { requestId });
  }
  if (stage.is_won || stage.is_lost) {
    return fail(
      "destino_fechado",
      t("Escolha uma etapa aberta. Para ganhar ou perder, use os botões do negócio."),
      422,
      { requestId },
    );
  }

  const veredito = validaCamposExigidos({
    lead: lead as Record<string, unknown>,
    settingsDoFunil: await settingsDoFunil(supabase, stage.pipeline_id),
    destino: { stageId: stage.id, desfecho: null },
    motivoDeGanho: null,
    customFieldsPropostos: input.custom_fields ?? null,
  });
  if (veredito.faltando.length > 0) {
    const recusa = recusaDeCamposObrigatorios(veredito.faltando, user.idioma);
    return fail(recusa.codigo, recusa.mensagem, 422, {
      requestId,
      details: { faltando: veredito.faltando },
    });
  }

  // A origem é lida ANTES de escrever: o lead em memória não pode ser a fonte
  // do "de onde veio" depois do update.
  const origemPipelineId = lead.pipeline_id as string;
  const origemStageId = lead.stage_id as string;

  // Entra no TOPO da coluna de destino, como card recém-chegado.
  const { data: primeiro } = await supabase
    .from("crm_leads")
    .select("position_in_stage")
    .eq("organization_id", orgId)
    .eq("stage_id", stage.id)
    .order("position_in_stage", { ascending: true })
    .limit(1)
    .maybeSingle();
  const posicao = midpoint(null, primeiro ? Number(primeiro.position_in_stage) : null);

  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      pipeline_id: stage.pipeline_id,
      stage_id: stage.id,
      position_in_stage: posicao,
      updated_at: new Date().toISOString(),
      ...(input.custom_fields
        ? {
            custom_fields: {
              ...((lead.custom_fields ?? {}) as Record<string, unknown>),
              ...input.custom_fields,
            },
          }
        : {}),
    })
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .eq("updated_at", input.expected_updated_at)
    .select("id")
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });
  if (!updated) {
    return fail(
      "lead_stage_changed_concurrent",
      t("Lead foi modificado por outro usuário. Recarregue e tente novamente."),
      409,
      { requestId },
    );
  }

  const { data: origem } = await supabase
    .from("crm_stages")
    .select("name")
    .eq("id", origemStageId)
    .maybeSingle();
  const atividade = await emitLeadActivity(supabase, {
    organizationId: orgId,
    leadId,
    contactId: (lead.contact_id as string | null) ?? null,
    type: "stage_changed",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: user.id },
    reason: stageChangeReason(origem?.name ?? null, stage.name),
    payload: {
      from_stage_id: origemStageId,
      to_stage_id: stage.id,
      from_pipeline_id: origemPipelineId,
      pipeline_id: stage.pipeline_id,
    },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: orgId,
      leadId,
      tipo: "stage_changed",
      origem: "leads/[id]/move-pipeline",
      erro: atividade.error,
      requestId,
    });
  }

  // Relido DEPOIS da atividade: ela toca `last_activity_at` e troca o
  // `updated_at` — a resposta tem de levar o carimbo final (mesmo caso do /move).
  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  await audit({
    action: "lead.moved_to_pipeline",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    metadata: {
      from_pipeline_id: origemPipelineId,
      to_pipeline_id: stage.pipeline_id,
      from_stage_id: origemStageId,
      to_stage_id: stage.id,
      modo: "mesmo_negocio",
    },
  });

  return ok(fresh ?? lead, { requestId });
}
