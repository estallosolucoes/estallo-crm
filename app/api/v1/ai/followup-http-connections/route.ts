import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/followup-http-connections — as conexões HTTP da organização, sem segredo (manager: quem edita fluxos).
 * POST /api/v1/ai/followup-http-connections — cria uma conexão (admin: é aqui que a credencial de outro sistema entra).
 *
 * A tabela não tem GRANT para `authenticated`: toda leitura e escrita passa por aqui, com o client de serviço e o
 * `organization_id` da SESSÃO. A credencial é cifrada antes do INSERT e nunca volta — só os 4 últimos caracteres.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { colunasDoSegredo, novaConexaoHttpSchema, origemDaConexao } from "@/lib/followup/requisicao-http";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS_SEGURAS = "id, label, base_url, auth_kind, header_name, secret_last4, created_at, updated_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_http_connections" });
  if (!authz.ok) return authz.response;
  const { data, error } = await createAdminClient()
    .from("automation_http_connections")
    .select(COLUNAS_SEGURAS)
    .eq("organization_id", authz.org.orgId)
    .order("label", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar conexões.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "automation_http_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const limite = await checkRateLimit(`followup-http-connections:write:${orgId}`, 30, 60);
  if (!limite.allowed)
    return fail("rate_limited", t("Muitas alterações em pouco tempo. Tente de novo em instantes."), 429, { requestId });

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = novaConexaoHttpSchema.safeParse(bruto);
  if (!parsed.success)
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId, details: parsed.error.flatten() });
  const input = parsed.data;

  let segredo: ReturnType<typeof colunasDoSegredo>;
  try {
    segredo = colunasDoSegredo(input.auth_kind, input.segredo);
  } catch {
    return fail(
      "cifra_indisponivel",
      t("Configure a chave de cifra do servidor (AI_CRED_AES_KEY) antes de cadastrar uma credencial."),
      422,
      { requestId },
    );
  }
  const { data: criada, error } = await createAdminClient()
    .from("automation_http_connections")
    .insert({
      organization_id: orgId,
      label: input.label,
      base_url: origemDaConexao(input.base_url)!,
      auth_kind: input.auth_kind,
      header_name: input.auth_kind === "header" ? input.header_name! : null,
      ...segredo,
      created_by: authz.user.id,
    })
    .select(COLUNAS_SEGURAS)
    .single();
  if (error || !criada) {
    if (error?.code === "23505")
      return fail("conexao_http_nome_em_uso", t("Já existe uma conexão com este nome."), 409, { requestId });
    return fail("internal_error", "Erro ao criar conexão.", 500, { requestId });
  }
  await audit({
    action: "automation_http_connection.created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "automation_http_connection",
    resourceId: criada.id,
    requestId,
    metadata: { label: criada.label, base_url: criada.base_url, auth_kind: criada.auth_kind },
  });
  return ok(criada, { status: 201, requestId });
}
