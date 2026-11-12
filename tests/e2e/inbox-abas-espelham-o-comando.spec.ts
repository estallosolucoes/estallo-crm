/** Categorias do Inbox por situação de resposta: lista e contadores concordam com o banco. */
import { expect, test } from "./helpers/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const env = carregarEnvLocal();
const admin: SupabaseClient = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Nomes próprios e improváveis: a org de teste é compartilhada entre specs. */
const ESPERANDO = "Zoraide Fila-Humana";
const ROBO = "Xisto Robo-Conduzindo";
const SESSAO = "aaaaaaaa-e2e0-4000-8000-00000000ab01";

async function limpar(orgId: string) {
  for (const nome of [ESPERANDO, ROBO, "QA Saída", "QA Encerrada"]) {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("display_name", nome);
    for (const c of data ?? []) {
      await admin
        .from("conversations")
        .delete()
        .eq("organization_id", orgId)
        .eq("contact_id", (c as { id: string }).id);
      await admin
        .from("contacts")
        .delete()
        .eq("organization_id", orgId)
        .eq("id", (c as { id: string }).id);
    }
  }
  await admin.from("channel_sessions").delete().eq("organization_id", orgId).eq("id", SESSAO);
}

async function semear(orgId: string) {
  await limpar(orgId);
  const { error: eSess } = await admin.from("channel_sessions").insert({
    id: SESSAO,
    organization_id: orgId,
    waha_session_name: `abas-comando-${Date.now()}`,
    webhook_secret_encrypted: "\\x00",
    status: "WORKING",
    display_name: "QA Status",
  });
  if (eSess) throw new Error(`fixture de canal falhou: ${eSess.message}`);

  for (const [nome, entrada, saida, status] of [
    [ESPERANDO, "2026-10-16T10:00:00Z", null, "open"],
    [ROBO, "2026-10-16T12:00:00Z", "2026-10-16T11:00:00Z", "open"],
    ["QA Saída", "2026-10-16T09:00:00Z", "2026-10-16T10:30:00Z", "open"],
    ["QA Encerrada", "2026-10-16T13:00:00Z", "2026-10-16T14:00:00Z", "closed"],
  ] as const) {
    const { data: ct, error: eCt } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: nome })
      .select("id")
      .single();
    if (eCt) throw new Error(`fixture de contato falhou: ${eCt.message}`);
    const { error: eConv } = await admin.from("conversations").insert({
      organization_id: orgId,
      contact_id: (ct as { id: string }).id,
      channel_session_id: SESSAO,
      status,
      assigned_to_user_id: null,
      bot_silenced_until: "infinity",
      last_inbound_at: entrada,
      last_outbound_at: saida,
      last_message_at: saida && saida > entrada ? saida : entrada,
      // A prévia NÃO repete o nome: `getByText(NOME)` casaria o título E a
      // prévia, e uma contagem de 2 onde se espera 1 vira ruído no diagnóstico.
      last_message_preview: "mensagem de teste",
    });
    if (eConv) throw new Error(`fixture de conversa falhou: ${eConv.message}`);
  }
}

test.describe("Inbox: categorias por situação de resposta", () => {
  // O teto global é 30 s e não cabe: só o login com MFA já consome uma boa parte
  // dele. Mesmo número da spec irmã `inbox-quem-manda.spec.ts`.
  test.describe.configure({ timeout: 180_000 });

  let orgId = "";

  test.beforeEach(async () => {
    orgId = (lerCreds() as unknown as { org_id: string }).org_id;
    await semear(orgId);
  });

  test.afterEach(async () => {
    if (orgId) await limpar(orgId);
  });

  test("os cinco status filtram a lista, contam o mesmo conjunto e explicam a espera", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox");
    await page.getByRole("button", { name: "Filtrar conversas" }).click();
    await page.getByLabel("Filtrar por canal").selectOption(SESSAO);
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    const lista = page.locator(".ibx-list-panel");
    await expect(lista.locator("[data-conversation-id]")).toHaveCount(4);
    await expect(page.getByRole("tab")).toHaveText([
      "Todas4",
      "Sem resposta1",
      "Em espera1",
      "Em aberto1",
      "Fechadas1",
    ]);
    for (const [aba, nome] of [
      ["Sem resposta", ESPERANDO],
      ["Em espera", ROBO],
      ["Em aberto", "QA Saída"],
      ["Fechadas", "QA Encerrada"],
    ]) {
      await page.getByRole("tab", { name: new RegExp(`^${aba}`) }).click();
      await expect(lista.locator("[data-conversation-id]")).toHaveCount(1);
      await expect(lista.getByText(nome!, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("tab", { name: /^Fila/ })).toHaveCount(0);
    await expect(lista.getByText(/na fila/)).toHaveCount(0);
    await page.getByRole("button", { name: "O que significa cada status do chat?" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "Primeiro contato: ainda não recebeu nenhuma resposta.",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: /^Todas/ }).click();
    await page.getByRole("button", { name: "Filtrar conversas" }).click();
    await page.getByLabel("Ordem", { exact: true }).selectOption("antigo");
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(lista.locator("[data-conversation-id]").first()).toContainText(ESPERANDO);
    await page.getByRole("button", { name: "Filtrar conversas" }).click();
    await page.getByLabel("Ordem", { exact: true }).selectOption("recente");
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(lista.locator("[data-conversation-id]").first()).toContainText("QA Encerrada");
  });
});
