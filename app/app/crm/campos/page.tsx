import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CamposPersonalizadosClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campos personalizados" };

/** CRM › Campos personalizados — só quem administra a empresa (a API exige o mesmo). */
export default async function CamposPersonalizadosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin && !user.is_platform_admin) notFound();
  return <CamposPersonalizadosClient />;
}
