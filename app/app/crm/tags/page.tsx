import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { TagsClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tags" };

/**
 * CRM › Tags — o cadastro de etiquetas de oportunidade e de contato (0659).
 * `manager`, a mesma régua da rota `/api/v1/tags/vocabulario` e da função do
 * banco: quem arruma etiqueta é quem monta as regras que a escrevem.
 */
export default async function TagsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // Sem atalho de platform admin: a rota e a função do banco também não têm.
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  return <TagsClient />;
}
