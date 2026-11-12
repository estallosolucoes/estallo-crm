/**
 * Com a Agenda desligada na organização (chave em /app/crm, padrão desligada),
 * esta tela não existe para ela — 404, como Propostas desligada.
 */
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function AgendaLayout({ children }: { children: ReactNode }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const ligadas = await capacidadesDaOrganizacao(createAdminClient(), activeOrg.orgId);
  if (!ligadas.includes("agenda")) notFound();
  return <>{children}</>;
}
