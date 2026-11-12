// Prova visual sem operações de pagamento, mensagens ou alterações cadastrais.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const origin = process.env.ESTALLO_QA_URL ?? "http://127.0.0.1:3001";
const deployMode = process.env.ESTALLO_QA_DEPLOY === "1";
if (
  deployMode
    ? origin !== "https://crm.estallo.com.br"
    : !["127.0.0.1", "localhost"].includes(new URL(origin).hostname)
)
  throw new Error(
    "QA aceita localhost ou, no modo deploy explícito, o domínio Estallo autorizado.",
  );
if (deployMode && (!process.env.ESTALLO_QA_CREDENTIALS || !process.env.ESTALLO_QA_SHA))
  throw new Error("Prova de deploy exige arquivo protegido e revisão esperada.");
const destination = path.resolve(
  deployMode ? "evidence/estallo-deploy-2026-10-14" : "evidence/estallo-identidade",
);
await fs.mkdir(destination, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(120_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message.replace(/https?:\/\/\S+/g, "[url]")));
const checks = {};
let stage = "acesso público";

async function capture(name, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content:
      'nextjs-portal, button[aria-label*="React Query Devtools"] { visibility: hidden !important; }',
  });
  await page.screenshot({ path: path.join(destination, name), fullPage });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    throw new Error(`Overflow horizontal: ${name}`);
}

try {
  if (deployMode) {
    stage = "saúde e revisão";
    const response = await context.request.get(`${origin}/api/v1/health`);
    const health = (await response.json()).data;
    if (
      !response.ok() ||
      health.status !== "healthy" ||
      health.version !== process.env.ESTALLO_QA_SHA
    )
      throw new Error("Versão ou saúde do deploy não corresponde ao aceite.");
    checks.origin = origin;
    checks.revision = health.version;
    checks.dependencies = health.checks;
  }
  stage = "login e temas";
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.getByRole("button", { name: "Entrar", exact: true }).waitFor({ timeout: 120_000 });
  checks.title = await page.title();
  await capture("login-desktop.png");
  await page.evaluate(() => localStorage.setItem("deskcomm-theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  await capture("login-escuro.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("login-mobile-escuro.png");
  await page.evaluate(() => localStorage.setItem("deskcomm-theme", "light"));
  await page.reload({ waitUntil: "networkidle" });
  await capture("login-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const icon = await context.request.get(`${origin}/icon`);
  checks.icon = { status: icon.status(), type: icon.headers()["content-type"] };

  const credentialsPath = process.env.ESTALLO_QA_CREDENTIALS;
  if (credentialsPath) {
    stage = "autenticação";
    const raw = await fs.readFile(credentialsPath, "utf8");
    const credentials = Object.fromEntries(
      raw
        .split(/\r?\n/)
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => {
          const position = line.indexOf("=");
          return [
            line.slice(0, position),
            line
              .slice(position + 1)
              .trim()
              .replace(/^("|')(.*)\1$/, "$2"),
          ];
        }),
    );
    if (!credentials.OWNER_EMAIL || !credentials.OWNER_PASSWORD)
      throw new Error("Arquivo sem credenciais do administrador.");
    await page.getByLabel("Email", { exact: true }).fill(credentials.OWNER_EMAIL);
    await page.getByLabel("Senha", { exact: true }).fill(credentials.OWNER_PASSWORD);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL((url) => !["/login", "/app"].includes(url.pathname), {
      timeout: 120_000,
    });
    await page.goto(`${origin}/app/settings/billing`, {
      waitUntil: "domcontentloaded",
      timeout: 300_000,
    });
    stage = "planos e navegação";
    checks.billingPath = new URL(page.url()).pathname;
    if (deployMode && checks.billingPath !== "/app/settings/billing")
      throw new Error("A sessão não alcançou a tela de planos autenticada.");
    if (checks.billingPath === "/app/settings/billing") {
      await page.getByRole("heading", { name: "Plano e cobrança", exact: true }).waitFor();
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="Recolher sidebar"]');
        return button && Object.keys(button).some((key) => key.startsWith("__reactFiber$"));
      });
      if ((await page.getByRole("button", { name: "Contratação em breve" }).count()) !== 3)
        throw new Error("Planos demonstrativos ausentes.");
      for (const button of await page.getByRole("button", { name: "Contratação em breve" }).all())
        if (!(await button.isDisabled())) throw new Error("Contratação demonstrativa está ativa.");
      await capture("planos-desktop.png");
      checks.navColor = await page
        .locator("aside.estallo-navigation")
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      await page.getByRole("button", { name: "Recolher sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Expandir sidebar", exact: true }).waitFor();
      await capture("navegacao-recolhida.png");
      await page.getByRole("button", { name: "Expandir sidebar", exact: true }).click();
      await page.getByRole("button", { name: "Recolher sidebar", exact: true }).waitFor();
      await page.evaluate(() => localStorage.setItem("deskcomm-theme", "dark"));
      await page.reload({ waitUntil: "networkidle" });
      await capture("planos-escuro.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture("planos-mobile.png");
      await page.getByRole("button", { name: "Abrir navegação", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await capture("navegacao-mobile.png", false);
      checks.mobileDrawer = true;
    }
  }
  checks.pageErrors = errors.length;
  if (errors.length) throw new Error("Erros de navegador durante a prova visual.");
  await fs.writeFile(
    path.join(destination, "resultado.json"),
    JSON.stringify(checks, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(checks) + "\n");
} catch (error) {
  // Erros do Playwright podem incluir o valor de fill(); jamais imprimir a senha.
  process.stderr.write(JSON.stringify({ ok: false, stage, errorType: error.name }) + "\n");
  process.exitCode = 1;
} finally {
  await browser.close();
}
