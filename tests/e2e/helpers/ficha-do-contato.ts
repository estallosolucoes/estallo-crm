import { expect, type Page } from "./test";

/**
 * Abre a ficha do contato (CRMSidePanel) no Inbox. No Estallo ela só vira COLUNA na faixa `2xl` (>= 1536px);
 * abaixo disso é uma gaveta que a pessoa abre pelo botão «Informações do contato» do cabeçalho do chat. Spec que
 * lê `inbox-demandas`, `inbox-memoria` ou `inbox-acervo` precisa abri-la — como a pessoa faria — antes de medir.
 * Idempotente: já aberta (coluna ou gaveta), não clica de novo.
 */
export async function abrirFichaDoContato(page: Page): Promise<void> {
  const alternar = page.getByTestId("alternar-ficha");
  await expect(alternar, "o botão da ficha não apareceu — a conversa não abriu").toBeVisible({ timeout: 30_000 });
  if ((await alternar.getAttribute("aria-pressed")) !== "true") await alternar.click();
  await expect(alternar).toHaveAttribute("aria-pressed", "true");
}
