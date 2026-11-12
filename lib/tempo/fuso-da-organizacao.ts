import type { SupabaseClient } from "@supabase/supabase-js";

import { fusoUtilizavel } from "@/lib/tempo/fusos";

/**
 * O fuso da ORGANIZAÇÃO — o único relógio que sobrou depois que o canal deixou de ter janela própria.
 * Valor ausente ou inválido cai no padrão (`fusoUtilizavel`): o `Intl` lança num fuso que não existe, e isso não pode
 * derrubar um envio. Filtra `organization_id` à mão (client de serviço).
 */
export async function fusoDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await admin.from("organizations").select("timezone").eq("id", organizationId).maybeSingle();
  return fusoUtilizavel((data as { timezone?: string | null } | null)?.timezone);
}
