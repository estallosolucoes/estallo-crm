import { readFileSync } from "node:fs";
import { join } from "node:path";

import { test, expect, type Page } from "./helpers/test";

interface TestCredentials {
  password: string;
  users: Record<string, { email: string }>;
}

function credentials(): TestCredentials {
  return JSON.parse(
    readFileSync(join(process.cwd(), ".e2e-creds.json"), "utf8"),
  ) as TestCredentials;
}

async function login(page: Page, role: "manager" | "viewer") {
  const creds = credentials();
  const email = creds.users[role]?.email;
  if (!email || !creds.password)
    throw new Error("Prepare as credenciais locais de manager e viewer antes desta spec.");
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
}

async function openPolicy(page: Page) {
  await page.getByRole("button", { name: "Retenção do histórico", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Dados das etapas (dias)")).toBeVisible();
  return dialog;
}

async function chooseTheme(page: Page, target: "light" | "dark") {
  const html = page.locator("html");
  if ((await html.getAttribute("data-theme")) !== target) {
    await page.getByRole("button", { name: /^Tema:/ }).click();
  }
  await expect(html).toHaveAttribute("data-theme", target);
}

test.describe("[P0] retenção de automações pela tela", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(async ({ baseURL }) => {
    if (!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) {
      throw new Error("Esta jornada só pode executar contra o aplicativo local.");
    }
  });

  test("manager salva e reabre os prazos; formulário cabe em desktop e mobile", async ({
    page,
  }, testInfo) => {
    await login(page, "manager");
    const priorResponse = await page.request.get("/api/v1/ai/followup-flows/retention");
    expect(priorResponse.status()).toBe(200);
    const prior = (await priorResponse.json()).data.policy as {
      payload_days: number;
      metadata_days: number;
    };
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto("/app/ai/followups");
      await chooseTheme(page, "light");
      const dialog = await openPolicy(page);
      await dialog.getByLabel("Dados das etapas (dias)").fill("15");
      await dialog.getByLabel("Histórico de execuções (dias)").fill("365");
      await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("Configuração salva.");
      await page.reload();
      const reopened = await openPolicy(page);
      await expect(reopened.getByLabel("Dados das etapas (dias)")).toHaveValue("15");
      await expect(reopened.getByLabel("Histórico de execuções (dias)")).toHaveValue("365");
      await page.screenshot({ path: testInfo.outputPath("retencao-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await reopened.getByRole("button", { name: "Salvar", exact: true }).scrollIntoViewIfNeeded();
      await expect(reopened.getByRole("button", { name: "Salvar", exact: true })).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("retencao-mobile.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await chooseTheme(page, "dark");
      const darkDialog = await openPolicy(page);
      await expect(darkDialog.getByLabel("Dados das etapas (dias)")).toHaveValue("15");
      await page.screenshot({
        path: testInfo.outputPath("retencao-desktop-escuro.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await darkDialog
        .getByRole("button", { name: "Salvar", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        darkDialog.getByRole("button", { name: "Salvar", exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath("retencao-mobile-escuro.png"),
        fullPage: true,
      });
    } finally {
      // Restaura pela mesma superfície, sem sobrescrever settings por SQL.
      await page.goto("/app/ai/followups");
      const dialog = await openPolicy(page);
      await dialog.getByLabel("Dados das etapas (dias)").fill(String(prior.payload_days));
      await dialog.getByLabel("Histórico de execuções (dias)").fill(String(prior.metadata_days));
      await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("Configuração salva.");
    }
  });

  test("viewer não encontra a configuração e a API também recusa", async ({ page }) => {
    await login(page, "viewer");
    await page.goto("/app/ai/followups");
    await expect(
      page.getByRole("button", { name: "Retenção do histórico", exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get("/api/v1/ai/followup-flows/retention")).status()).toBe(403);
    expect(
      (
        await page.request.patch("/api/v1/ai/followup-flows/retention", {
          data: { payload_days: 30, metadata_days: 180 },
        })
      ).status(),
    ).toBe(403);
  });
});
