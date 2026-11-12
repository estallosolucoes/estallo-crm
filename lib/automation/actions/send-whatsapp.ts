import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { esperarRitmo } from "@/lib/messaging/ritmo-entre-envios";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { reportarEnvio, type MensagemEnviada } from "@/lib/automation/desfecho-do-envio";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";

async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const contato = checarGuardasDeContato(ctx);
  if (contato.ok) {
    const protection = (await protecaoAgendaSupabase(ctx.admin, ctx.organizationId, [contato.contact.id])).get(contato.contact.id)!;
    if (protection.motivo === "leitura_indisponivel") throw new Error("agenda_read_failed");
    if (protection.adiar) return protection.reavaliar_em;
  }
  return null;
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const sessionId = typeof config.channel_session_id === "string" ? config.channel_session_id : null;
  const template = typeof config.template === "string" ? config.template : null;
  if (!sessionId || !template) {
    return { type: "send_whatsapp_message", status: "failed", error: "missing_config" };
  }
  // Guardas compartilhadas com send_ai_message — ver guarda-do-contato.ts
  // (existe/bloqueado/telefone/consentimento, este último um gate FIXO).
  const guarda = checarGuardasDeContato(ctx);
  if (!guarda.ok) return { type: "send_whatsapp_message", status: "skipped", detail: { reason: guarda.reason } };
  const contact = guarda.contact;

  // O ritmo entre envios é COMPARTILHADO com a ação de IA (mesmo número, mesmo
  // contador) — ver lib/messaging/ritmo-entre-envios.ts.
  try {
    await assertAgendaEffectSupabase(ctx.admin, { organizationId: ctx.organizationId, contactId: contact.id });
    const boundary = await serviceForAutomation(ctx, contact.id, sessionId);
    const conversationId = boundary.conversation_id;
    await esperarRitmo(sessionId);
    const body = renderTemplate(template, ctx.context);
    const message = await sendMessageHandler(
      ctx.admin,
      {
        organization_id: ctx.organizationId,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: ctx.organizationId, contactId: contact.id },
        actor: { type: "webhook_source", id: ctx.ruleId },
        requestId: `rule:${ctx.ruleId}`,
      },
      { conversation_id: conversationId, type: "text", body } as Parameters<typeof sendMessageHandler>[2],
    );
    // O desfecho vem do ESTADO DA MENSAGEM, nunca da ausência de exceção:
    // `sendMessageHandler` marca `failed`/`queued` e devolve normalmente (ver
    // lib/automation/desfecho-do-envio.ts para o defeito medido).
    return await reportarEnvio(ctx, "send_whatsapp_message", message as unknown as MensagemEnviada, conversationId);
  } catch (err) {
    return {
      type: "send_whatsapp_message",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

registerAction({ type: "send_whatsapp_message", postponeUntil, execute });
