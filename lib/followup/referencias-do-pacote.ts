/**
 * Referências externas de um pacote de automação (Fase 7), no SERVIDOR: o que cada UUID citado é na organização de
 * origem (para o manifesto), o que a organização de destino oferece para remapear, e a conferência do remapeamento.
 *
 * Toda leitura usa o client de serviço com `organization_id` filtrado à mão, de fonte confiável (quem chama passa a
 * organização da sessão). Nome igual NUNCA vincula: o destino é sempre escolhido, e precisa existir no tenant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Pacote, TipoDeReferencia } from "./pacote";

export type Candidatos = Record<Exclude<TipoDeReferencia, "desconhecido">, Array<{ id: string; nome: string }>>;

async function nomeDoUsuario(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.auth.admin.getUserById(userId);
  return (data?.user?.user_metadata?.full_name as string | undefined) ?? data?.user?.email ?? userId.slice(0, 8);
}

/** Tudo que a organização tem para ser destino de um remapeamento. */
export async function candidatosDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<Candidatos> {
  const [funis, etapas, membros, tipos, agentes, conexoes] = await Promise.all([
    admin.from("crm_pipelines").select("id,name").eq("organization_id", orgId),
    admin.from("crm_stages").select("id,name,pipeline_id").eq("organization_id", orgId),
    admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", orgId)
      .is("revoked_at", null)
      .neq("role", "viewer"),
    admin.from("calendar_event_types").select("id,name").eq("organization_id", orgId),
    admin.from("ai_agents").select("id,name").eq("organization_id", orgId),
    // Só o nome e o id: a credencial nunca viaja no pacote, quem importa escolhe a conexão equivalente no destino.
    admin.from("automation_http_connections").select("id,label").eq("organization_id", orgId),
  ]);
  for (const r of [funis, etapas, membros, tipos, agentes, conexoes]) if (r.error) throw new Error(r.error.message);
  const nomeDoFunil = new Map((funis.data ?? []).map((f) => [f.id as string, f.name as string]));
  return {
    funil: (funis.data ?? []).map((f) => ({ id: f.id as string, nome: f.name as string })),
    etapa: (etapas.data ?? []).map((e) => ({
      id: e.id as string,
      nome: `${e.name as string} · ${nomeDoFunil.get(e.pipeline_id as string) ?? "?"}`,
    })),
    usuario: await Promise.all(
      (membros.data ?? []).map(async (m) => ({ id: m.user_id as string, nome: await nomeDoUsuario(admin, m.user_id as string) })),
    ),
    tipo_de_agenda: (tipos.data ?? []).map((t) => ({ id: t.id as string, nome: t.name as string })),
    agente: (agentes.data ?? []).map((a) => ({ id: a.id as string, nome: a.name as string })),
    conexao_http: (conexoes.data ?? []).map((c) => ({ id: c.id as string, nome: c.label as string })),
  };
}

/** O manifesto: cada UUID citado, com o tipo e o nome na origem. O que não se reconhece fica `desconhecido`. */
export function classificarReferencias(uuids: string[], origem: Candidatos): Pacote["dependencias"] {
  return uuids.map((id) => {
    for (const tipo of Object.keys(origem) as Array<keyof Candidatos>) {
      const achado = origem[tipo].find((c) => c.id.toLowerCase() === id);
      if (achado) return { id, tipo, nome: achado.nome };
    }
    return { id, tipo: "desconhecido" as const, nome: id };
  });
}

/** Cada destino escolhido tem de existir no tenant, e ser do MESMO tipo. Devolve o problema, ou `null`. */
export function problemaDoMapa(
  dependencias: Pacote["dependencias"],
  mapa: Record<string, string>,
  destino: Candidatos,
): string | null {
  for (const d of dependencias) {
    if (d.tipo === "desconhecido")
      return `O fluxo cita uma referência que esta versão não sabe remapear (${d.id}). Remova-a do fluxo de origem e exporte de novo.`;
    const alvo = mapa[d.id];
    if (!alvo) return `Escolha o equivalente de «${d.nome}».`;
    if (!destino[d.tipo].some((c) => c.id === alvo))
      return `O destino escolhido para «${d.nome}» não existe nesta organização.`;
  }
  return null;
}
