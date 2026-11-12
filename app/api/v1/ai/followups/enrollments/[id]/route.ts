/**
 * GET /api/v1/ai/followups/enrollments/:id (any member) — o dossiê de UM
 * follow-up: quem é o contato, em que passo está, quando volta a andar, o que
 * já aconteceu (a tabela `followup_enrollment_events`, que existe desde a 0054 e
 * nenhuma tela lia) e, quando houver, o plano de tempo que o agente decidiu.
 *
 * Três decisões que valem mais que o código:
 *
 * 1. **O grafo NÃO sai inteiro.** A leitura é `viewer`, e `config` carrega o
 *    `prompt_hint` — a instrução que o dono do fluxo escreveu para o agente.
 *    Editar fluxo exige `manager`; devolver o config cru daria a quem só lê o
 *    que ele não pode nem abrir. Sai a projeção de `resumoDoNo`.
 *
 * 2. **Grafo pinado ilegível não derruba o dossiê.** `safeParse`: se a versão
 *    pinada não valida contra o schema de hoje, os passos aparecem pelo id com
 *    a frase que diz que é um id. Falhar fechado aqui apagaria justamente a
 *    história de quem mais precisa dela.
 *
 * 3. **`claimed_until` vai para a resposta.** É o que explica um 409 na hora de
 *    intervir: sem ele, a tela diria "não deu" sem poder dizer por quê.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  resumoDoNo,
  rotuloDaAresta,
  type EventoDeEnrollment,
  type NoDoDossie,
} from "@/lib/followup/eventos-legiveis";
import { carregaEtapasCitadas, nomesDasEtapas } from "@/lib/followup/etapas-citadas";
import { leituraDoPlano, type TimingPlan } from "@/lib/followup/plano-de-tempo";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { montarPassos, type PassoDaExecucao } from "@/lib/followup/passos-da-execucao";
import { roleAtLeast } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Teto de eventos lidos. O motor escreve ~1 por passo e para em `MAX_STEPS`
 * (80); reactivity e intervenção manual somam poucos. 500 cobre o pior caso com
 * folga — e o `truncado` abaixo existe para que, se algum dia não cobrir, a tela
 * DIGA que está mostrando um pedaço, em vez de mentir por omissão.
 */
const TETO_DE_EVENTOS = 500;

type RouteCtx = { params: Promise<{ id: string }> };

export interface DossieDoEnrollment {
  id: string;
  status: string;
  current_node_id: string;
  next_eval_at: string | null;
  claimed_until: string | null;
  /**
   * O worker está com este enrollment reclamado NESTE INSTANTE.
   *
   * Derivado no servidor de propósito: a comparação é com `now()`, e o relógio
   * que vale é o do lado do banco — o do navegador pode estar minutos fora. É
   * também o que explica um 409 na hora de intervir.
   */
  motor_ocupado: boolean;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  outcome: string | null;
  cancel_reason: string | null;
  last_error: string | null;
  attempts: number;
  max_attempts: number;
  steps_taken: number;
  contact: { id: string; name: string };
  flow: {
    pointer_id: string;
    name: string | null;
    version_id: string;
  };
  agent_name: string | null;
  no_atual: NoDoDossie | null;
  nos: NoDoDossie[];
  /** As ligações do grafo pinado (só origem e destino): é o que permite desenhar o caminho percorrido. */
  arestas: Array<{ id: string; source: string; target: string }>;
  /**
   * O caminho percorrido, em ordem, do diário de execução. Vazio para execução anterior ao diário (contrato 0).
   * `entrada`/`saida` de cada passo só vêm para quem edita fluxo (`pode_ver_dados`).
   */
  passos: PassoDaExecucao[];
  /** Conduzida bloco a bloco pelo operador (o motor pausa depois de cada bloco). */
  passo_a_passo: boolean;
  /** De qual execução esta nasceu (reinício), ou `null` quando é a original. */
  origem: { id: string; tipo: string } | null;
  /** Reexecuções nascidas desta (mais novas primeiro). */
  reexecucoes: Array<{ id: string; tipo: string; status: string; started_at: string }>;
  pode_ver_dados: boolean;
  /**
   * O grafo pinado COM posições e configuração, para desenhar o caminho no canvas. Só para quem edita fluxos
   * (`pode_ver_dados`): o cartão de cada bloco mostra a configuração, que tem o texto que o dono escreveu.
   */
  grafo: { nodes: unknown[]; edges: unknown[] } | null;
  /** Saídas do nó atual — é o que a tela oferece para "pular este passo". */
  saidas: Array<{ edge_id: string; target_id: string; target_rotulo: string; quando: string }>;
  eventos: EventoDeEnrollment[];
  eventos_truncados: boolean;
  /** O diário passou do teto de leitura: `passos` são os primeiros, não todos. */
  passos_truncados: boolean;
  /** Recuperação: os passos concluídos pela execução original (checkpoint herdado). Vazio fora de recuperação. */
  passos_herdados: PassoDaExecucao[];
  plano_de_tempo: TimingPlan | null;
  /** id → nome de quem interveio. "Uma pessoa da equipe" não responde "quem?". */
  autores: Record<string, string>;
}

function embedded<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Os nomes de quem interveio, resolvidos uma vez por pessoa.
 *
 * Mesmo caminho de `lib/leads/timeline-query.ts`, inclusive os IMPORTS TARDIOS:
 * `@/lib/audit` e `@/lib/supabase/admin` arrastam `@/lib/env`, que lança se
 * faltar variável — no topo, quebrariam qualquer teste que só importasse este
 * módulo. Sem service role configurado, os nomes simplesmente não vêm e a tela
 * cai em "uma pessoa da equipe": a falta do nome nunca derruba o dossiê.
 */
async function resolveAutores(eventos: Array<{ payload: unknown }>): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      eventos
        .map((e) => (e.payload as { actor_user_id?: unknown } | null)?.actor_user_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  if (ids.length === 0) return {};

  const { isServiceRoleConfigured } = await import("@/lib/audit");
  if (!isServiceRoleConfigured()) return {};
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const nomes: Record<string, string> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        const nome = data?.user?.user_metadata?.full_name ?? data?.user?.email;
        if (typeof nome === "string" && nome.trim() !== "") nomes[id] = nome;
      } catch {
        // Nome que não resolve não é erro do dossiê — a linha existe com ou sem ele.
      }
    }),
  );
  return nomes;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("viewer", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("followup_enrollments")
    .select(
      `id, status, contact_id, pointer_id, version_id, current_node_id, next_eval_at, claimed_until,
       started_at, completed_at, updated_at, outcome, cancel_reason, last_error, attempts, max_attempts,
       steps_taken, timing_plan, source_enrollment_id, recovery_kind, passo_a_passo,
       contacts:contact_id(id, name, display_name, phone_number),
       followup_flow_pointers:pointer_id(name),
       ai_agents:agent_id(name),
       followup_flow_versions:version_id(graph)`,
    )
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!row) return fail("not_found", t("Follow-up não encontrado."), 404, { requestId });

  const { data: eventos, error: evErr } = await supabase
    .from("followup_enrollment_events")
    .select("id, node_id, event_type, payload, created_at")
    .eq("organization_id", org.orgId)
    .eq("enrollment_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(TETO_DE_EVENTOS + 1);
  if (evErr) return fail("internal_error", evErr.message, 500, { requestId });

  const { data: filhas } = await supabase
    .from("followup_enrollments")
    .select("id, status, recovery_kind, started_at")
    .eq("organization_id", org.orgId)
    .eq("source_enrollment_id", id)
    .order("started_at", { ascending: false })
    .limit(50);

  const lidos = eventos ?? [];
  const truncado = lidos.length > TETO_DE_EVENTOS;

  const versao = embedded(row.followup_flow_versions as { graph: unknown } | { graph: unknown }[] | null);
  const grafo = versao ? flowGraphSchema.safeParse(versao.graph) : null;
  const nos: NoDoDossie[] = grafo?.success ? grafo.data.nodes.map(resumoDoNo) : [];
  const porId = new Map(nos.map((n) => [n.id, n]));

  // O nó de ORIGEM vai junto: no grafo v2 o rótulo do ramo mora nele, não na
  // aresta — sem ele a tela ofereceria "pelo ramo b3f1" na hora de escolher
  // por onde pular.
  const noDeOrigem = grafo?.success
    ? grafo.data.nodes.find((n) => n.id === row.current_node_id)
    : undefined;
  // A regra de etapa guarda o id; o nome vem do banco. Falha aqui não derruba o
  // dossiê — a frase só descreve a opção, e cai em "(não encontrada)" sem id.
  const citadas = await carregaEtapasCitadas(supabase, org.orgId, noDeOrigem ? [noDeOrigem] : []);
  const nomesDeEtapa = citadas.ok ? nomesDasEtapas(citadas.etapas) : {};
  const saidas = (grafo?.success ? grafo.data.edges : [])
    .filter((e) => e.source === row.current_node_id)
    .sort((a, b) => b.priority - a.priority)
    .map((e) => ({
      edge_id: e.id,
      target_id: e.target,
      target_rotulo: porId.get(e.target)?.rotulo ?? e.target,
      quando: rotuloDaAresta(e, noDeOrigem, nomesDeEtapa),
    }));

  // O diário (contrato 1). A leitura é pela sessão da pessoa: a RLS das tabelas decide o que ela vê.
  const podeVerDados = roleAtLeast(org.role, "manager");
  const { data: passosBrutos, error: passosErr } = await supabase
    .from("followup_execution_steps")
    .select("id, node_id, visit, status, branch_id, entered_at, completed_at")
    .eq("organization_id", org.orgId)
    .eq("enrollment_id", id)
    .order("entered_at", { ascending: true })
    // ponytail: sem paginação — o motor mata a execução acima de MAX_STEPS (80), então 500 não se alcança; se alcançar,
    // `passos_truncados` faz a tela dizer que mostra um pedaço. Paginar quando execuções longas existirem de verdade.
    .limit(TETO_DE_EVENTOS + 1);
  if (passosErr) return fail("internal_error", passosErr.message, 500, { requestId });
  const passosTruncados = (passosBrutos ?? []).length > TETO_DE_EVENTOS;
  const passosLidos = (passosBrutos ?? []).slice(0, TETO_DE_EVENTOS);
  const idsDosPassos = passosLidos.map((p) => p.id);
  const { data: tentativasBrutas, error: tentativasErr } =
    idsDosPassos.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("followup_execution_attempts")
          .select("step_id, attempt_no, status, started_at, completed_at, input_snapshot, output_snapshot, error_snapshot")
          .eq("organization_id", org.orgId)
          .in("step_id", idsDosPassos);
  if (tentativasErr) return fail("internal_error", tentativasErr.message, 500, { requestId });
  const passos = montarPassos(passosLidos, tentativasBrutas ?? [], porId, podeVerDados);

  // Recuperação (Fase 6): os passos que a ORIGINAL concluiu são o checkpoint — aparecem como herdados, sem simular
  // execução nova. Só o resumo (bloco, ramo, quando): os dados ficam na execução original, a um clique.
  let passosHerdados: PassoDaExecucao[] = [];
  if (row.recovery_kind === "retry" && row.source_enrollment_id) {
    const { data: herdados, error: herdadosErr } = await supabase
      .from("followup_execution_steps")
      .select("id, node_id, visit, status, branch_id, entered_at, completed_at")
      .eq("organization_id", org.orgId)
      .eq("enrollment_id", row.source_enrollment_id as string)
      .eq("status", "succeeded")
      .order("entered_at", { ascending: true })
      .limit(TETO_DE_EVENTOS);
    if (herdadosErr) return fail("internal_error", herdadosErr.message, 500, { requestId });
    passosHerdados = montarPassos(herdados ?? [], [], porId, false);
  }

  const contato = embedded(
    row.contacts as
      | { id: string; name: string | null; display_name: string | null; phone_number: string | null }
      | Array<{ id: string; name: string | null; display_name: string | null; phone_number: string | null }>
      | null,
  );
  const pointer = embedded(
    row.followup_flow_pointers as
      | { name: string }
      | { name: string }[]
      | null,
  );
  const agente = embedded(row.ai_agents as { name: string } | { name: string }[] | null);

  const dossie: DossieDoEnrollment = {
    id: row.id,
    status: row.status,
    current_node_id: row.current_node_id,
    next_eval_at: row.next_eval_at,
    claimed_until: row.claimed_until,
    motor_ocupado: row.claimed_until !== null && Date.parse(row.claimed_until) > Date.now(),
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    outcome: row.outcome,
    cancel_reason: row.cancel_reason,
    last_error: row.last_error,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    steps_taken: row.steps_taken,
    contact: {
      id: row.contact_id,
      name: contato ? rotuloDoContato(contato) : "Contato removido",
    },
    flow: {
      pointer_id: row.pointer_id,
      name: pointer?.name ?? null,
      version_id: row.version_id,
    },
    agent_name: agente?.name ?? null,
    no_atual: porId.get(row.current_node_id) ?? null,
    nos,
    arestas: (grafo?.success ? grafo.data.edges : []).map((e) => ({ id: e.id, source: e.source, target: e.target })),
    passos,
    passo_a_passo: row.passo_a_passo === true,
    origem: row.source_enrollment_id
      ? { id: row.source_enrollment_id, tipo: row.recovery_kind ?? "restart" }
      : null,
    reexecucoes: (filhas ?? []).map((f) => ({
      id: f.id,
      tipo: f.recovery_kind ?? "restart",
      status: f.status,
      started_at: f.started_at,
    })),
    pode_ver_dados: podeVerDados,
    grafo: podeVerDados && grafo?.success ? { nodes: grafo.data.nodes, edges: grafo.data.edges } : null,
    saidas,
    eventos: lidos.slice(0, TETO_DE_EVENTOS) as EventoDeEnrollment[],
    eventos_truncados: truncado,
    passos_truncados: passosTruncados,
    passos_herdados: passosHerdados,
    plano_de_tempo: leituraDoPlano(row.timing_plan),
    autores: await resolveAutores(lidos),
  };

  return ok(dossie, { requestId });
}
