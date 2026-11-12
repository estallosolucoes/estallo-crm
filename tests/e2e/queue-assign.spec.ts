/**
 * G5-03 — atribuição preserva a conversa nas categorias por resposta.
 * Worker simulado pela função de atribuição; o cron não roda no e2e local.
 *
 * Pré-requisito: scripts/seed-e2e-credentials.ts + scripts/seed-e2e-queue.ts
 * (o beforeAll re-roda o queue seed para restaurar o estado de fila).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCE = path.join(process.cwd(), "loop/checkpoints/evidence/G5");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  queue?: {
    conversation_id: string;
    contact_name: string;
    agent_user_id: string;
  };
  supabase_url: string;
}

function loadEnv(): Record<string, string> {
  const env = carregarEnvLocal();
  return env;
}

const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
}

test.describe("G5-03 — atribuição sem posição na lista", () => {
  // Dev server compila /app/* a frio na 1ª visita (pode passar de 30s).
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    // Restaura o estado de fila (idempotente) antes do fluxo.
    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], {
      stdio: "pipe",
    });
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    if (!creds.queue) throw new Error("queue seed block ausente em .e2e-creds.json");

    // A CONVERSA PRECISA ESTAR ESCALADA PARA ESTAR NA FILA — mudou em 2026-08-31.
    //
    // Até a migration 0203, "na fila" era "sem dono + aberta". Só que numa org com
    // IA no ar isso descreve TAMBÉM a conversa que o robô está atendendo agora, e
    // era por contar essas que a Fila mostrava 83 numa instalação onde 47 já
    // estavam sendo respondidas. Agora a Fila pergunta quem espera uma PESSOA.
    //
    // O cenário desta spec (posição na fila + atribuição a um atendente) pressupõe
    // exatamente isso, então o estado tem de dizê-lo. Fica AQUI e não no
    // `seed-e2e-queue.ts` porque aquele seed é compartilhado com
    // `inbox-tempo-real` e `followup-queue`, que dependem do automático ATIVO —
    // silenciar lá consertaria esta e quebraria as outras duas.
    const { error: erroSilencio } = await admin
      .from("conversations")
      .update({ bot_silenced_until: "infinity" })
      .eq("organization_id", creds.org_id)
      .eq("id", creds.queue.conversation_id);
    if (erroSilencio) throw new Error(`não consegui escalar a conversa: ${erroSilencio.message}`);
  });

  test("conversa sem resposta continua visível após atribuir e aparece no filtro Minhas", async ({
    page,
  }) => {
    const q = creds.queue!;
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/inbox?filter=all");

    // (1) Todas mostra a conversa sem posição de fila.
    const queueItem = page.getByRole("button").filter({ hasText: q.contact_name });
    await expect(queueItem).toBeVisible({ timeout: 15_000 });
    await expect(queueItem.getByText(/na fila/)).toHaveCount(0);
    await page.screenshot({
      path: path.join(EVIDENCE, "G5-03-queue.png"),
      fullPage: true,
    });

    // (2) Worker atribui (fn_conversation_assign reason='routing') ao próprio agent.
    const { error } = await admin.rpc("fn_conversation_assign", {
      p_organization_id: creds.org_id,
      p_conversation_id: q.conversation_id,
      p_to_user_id: q.agent_user_id,
      p_reason: "routing",
      p_expected_assignee: null,
      p_enforce_expected: false,
    });
    if (error) throw new Error(`fn_conversation_assign: ${error.message}`);

    // (3) A atribuição não retira a conversa da lista.
    await page.reload();
    await page.goto("/app/inbox?filter=all");
    await expect(page.getByRole("button").filter({ hasText: q.contact_name })).toBeVisible({
      timeout: 15_000,
    });

    // (4) Aparece em Todas com o filtro "Minhas" do dono.
    await page.getByRole("tab", { name: /Todas/ }).click();
    await page.getByRole("button", { name: "Filtrar conversas" }).click();
    await page.getByRole("checkbox", { name: "Minhas" }).check();
    await page.getByRole("button", { name: "Aplicar filtros" }).click();
    await expect(page.getByRole("button").filter({ hasText: q.contact_name })).toBeVisible({
      timeout: 15_000,
    });
  });
});
