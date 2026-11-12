import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/media
 *
 * Sobe o ARQUIVO de um envio do bloco de mensagens do fluxo (imagem, vídeo, áudio ou documento). O arquivo
 * fica em `whatsapp-media/{org}/flow-assets/{uuid}/{arquivo}`; a resposta devolve o caminho, que o construtor
 * grava no item. No envio ele é copiado para a pasta da conversa (`lib/agent-engine/agent/anexos-do-fluxo.ts`).
 *
 * Auth: sessão por cookie, papel >= manager (o mesmo de quem edita fluxo). `organization_id` sai do JWT,
 * nunca do corpo. A régua de tipo e tamanho é a do envio da caixa de entrada (`validateOutboundMedia`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BUCKET_DE_ANEXOS,
  PASTA_DE_ANEXOS_DO_FLUXO,
} from "@/lib/agent-engine/agent/anexos-do-fluxo";

export const dynamic = "force-dynamic";

/** Só o nome do arquivo, em ASCII seguro: vira segmento de caminho no Storage e nome do documento no WhatsApp. */
function nomeSeguroDoArquivo(bruto: string): string {
  const base = bruto.split(/[\\/]/).pop() ?? "";
  const limpo = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return limpo || "arquivo";
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return fail("invalid_request", t("Falha ao processar o envio do arquivo."), 400, { requestId });
  }
  const arquivo = formData.get("file");
  if (!(arquivo instanceof File)) {
    return fail("invalid_request", t("Nenhum arquivo foi enviado."), 400, { requestId });
  }

  const mime = (arquivo.type || "application/octet-stream").trim();
  const valido = validateOutboundMedia(mime, arquivo.size);
  if (!valido.ok) {
    const status = valido.code === "payload_too_large" ? 413 : valido.code === "unsupported_media_type" ? 415 : 422;
    return fail(valido.code, t(valido.message), status, { requestId });
  }

  const filename = nomeSeguroDoArquivo(arquivo.name);
  const path = `${authz.org.orgId}/${PASTA_DE_ANEXOS_DO_FLUXO}/${randomUUID()}/${filename}`;
  const { error } = await createAdminClient()
    .storage.from(BUCKET_DE_ANEXOS)
    .upload(path, Buffer.from(await arquivo.arrayBuffer()), { contentType: mime, upsert: false });
  if (error) {
    console.error("[followup-flows-media] upload falhou:", error.message);
    return fail("internal_error", "Erro ao guardar o arquivo.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "followup_flow.media_uploaded",
    resourceType: "followup_flows",
    // O caminho não é uuid (a coluna é): fica no metadata.
    resourceId: null,
    metadata: { path, mime, size_bytes: arquivo.size },
    requestId,
  });

  return ok(
    { path, mime, filename, size_bytes: arquivo.size, kind: valido.kind },
    { status: 201, requestId },
  );
}
