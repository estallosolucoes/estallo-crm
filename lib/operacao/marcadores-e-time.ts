/**
 * Os MARCADORES em uso e QUEM TRABALHA na empresa — as duas leituras que fazem
 * o agente organizar a operação sem inventar vocabulário nem pessoa.
 *
 * ⚠️ POR QUE LISTAR MARCADOR RESOLVE MAIS DO QUE CRIAR. `crm_manage_tags` já
 * aplica marcador livre — o agente sempre pôde "criar" um digitando um nome
 * novo. O defeito real é o oposto: sem enxergar o que já existe, ele escreve
 * `cliente-vip` numa conversa e `vip` na seguinte, e o filtro do dono da loja
 * passa a mentir sobre quantos clientes VIP ele tem. A cura é a LISTA, não um
 * segundo escritor.
 *
 * Estallo (0659): o marcador é do CONTATO ou do NEGÓCIO (conversa não tem
 * mais), e o vocabulário oficial é o cadastro da tela Tags (`settings.tags`,
 * uma entrada por entidade). O agente lê aqui; quem cadastra é a tela.
 */
import { ApiError } from "@/lib/api/types";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

export type EntidadeDoMarcador = "lead" | "contact";

export interface MarcadorEmUso {
  marcador: string;
  /** `lead` = etiqueta de oportunidade; `contact` = etiqueta de contato. */
  entidade: EntidadeDoMarcador;
  /** Quantos registros (contatos ou negócios) o carregam agora. */
  uso: number;
  /** `true` = está no cadastro da tela Tags; `false` = nasceu no uso. */
  oficial: boolean;
}

/**
 * O cadastro oficial mais o que de fato está em uso, por entidade.
 *
 * ⚠️ AS DUAS FONTES JUNTAS, DE PROPÓSITO. Só o oficial esconderia os marcadores
 * que a operação inventou e usa todo dia; só os em uso esconderia o cadastro que
 * a empresa declarou e ninguém aplicou ainda.
 *
 * O teto existe porque isto entra no contexto de um modelo.
 */
export async function listarMarcadores(
  deps: DepsDaOperacao,
  opts: { limite?: number } = {},
): Promise<MarcadorEmUso[]> {
  const limite = opts.limite ?? 60;

  const { data: org, error: orgErr } = await deps.supabase
    .from("organizations")
    .select("settings")
    .eq("id", deps.organizationId)
    .maybeSingle();
  if (orgErr) throw new ApiError(500, "internal_error", undefined, deps.requestId, orgErr.message);

  const contagem = new Map<string, MarcadorEmUso>();
  const chave = (entidade: EntidadeDoMarcador, nome: string) => `${entidade}:${nome.toLowerCase()}`;
  const cadastro = (org?.settings as Record<string, unknown> | null)?.["tags"];
  for (const entrada of Array.isArray(cadastro) ? cadastro : []) {
    const obj = typeof entrada === "string" ? { tag: entrada } : (entrada as { tag?: unknown; entidade?: unknown });
    const nome = typeof obj?.tag === "string" ? obj.tag.trim() : "";
    if (!nome) continue;
    const entidades: EntidadeDoMarcador[] =
      obj.entidade === "lead" || obj.entidade === "contact" ? [obj.entidade] : ["lead", "contact"];
    for (const entidade of entidades) {
      contagem.set(chave(entidade, nome), { marcador: nome, entidade, uso: 0, oficial: true });
    }
  }

  // ⚠️ CONTAGEM EM JS: `tags` é `text[]` e o PostgREST não agrega. A leitura é
  // limitada; se um dia doer, vira RPC — e o contrato desta função não muda.
  for (const [tabela, entidade] of [
    ["contacts", "contact"],
    ["crm_leads", "lead"],
  ] as const) {
    const { data, error } = await deps.supabase
      .from(tabela)
      .select("tags")
      .eq("organization_id", deps.organizationId)
      .limit(2000);
    if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);
    for (const linha of (data ?? []) as unknown as Array<{ tags: string[] | null }>) {
      for (const nome of linha.tags ?? []) {
        const k = chave(entidade, nome);
        const atual = contagem.get(k) ?? { marcador: nome, entidade, uso: 0, oficial: false };
        atual.uso += 1;
        contagem.set(k, atual);
      }
    }
  }

  return [...contagem.values()]
    // Os mais usados primeiro: é a ordem em que alguém decidiria reaproveitar.
    .sort((a, b) => b.uso - a.uso || a.marcador.localeCompare(b.marcador))
    .slice(0, limite);
}

export interface PessoaDoTime {
  user_id: string;
  papel: string;
  /** `true` enquanto o convite não foi aceito — quem ainda não pode receber trabalho. */
  convite_pendente: boolean;
  desde: string;
}

/**
 * Quem trabalha aqui e com que papel.
 *
 * ⚠️ SEM E-MAIL, SEM NOME, SEM ÚLTIMO ACESSO — e a rota REST irmã devolve os
 * três. A diferença é o destinatário: o que sai daqui entra no contexto de um
 * modelo de linguagem e pode ser repetido numa conversa com um cliente. O
 * agente precisa saber A QUEM direcionar (o `user_id` que
 * `crm_assign_conversation` consome) e QUEM PODE receber (o papel); o e-mail do
 * atendente não participa de nenhuma dessas duas decisões.
 *
 * ⚠️ SÓ LEITURA. Mudar papel de alguém é RBAC e está fora do escopo desta wave
 * por decisão do despacho — e continua sendo, porque promover um colega é a
 * definição de mudança que ninguém quer descobrir depois.
 */
export async function listarTime(deps: DepsDaOperacao): Promise<PessoaDoTime[]> {
  const { data, error } = await deps.supabase
    .from("user_organizations")
    .select("user_id, role, accepted_at, created_at")
    .eq("organization_id", deps.organizationId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new ApiError(500, "internal_error", undefined, deps.requestId, error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((m) => ({
    user_id: m.user_id as string,
    papel: m.role as string,
    convite_pendente: m.accepted_at === null,
    desde: m.created_at as string,
  }));
}
