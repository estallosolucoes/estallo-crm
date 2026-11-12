import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { PgExecutionJournal } from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type * as ContractModule from "@/lib/followup/execution-contract";

vi.mock("@/lib/followup/execution-contract", async (original) => {
  const m = await original<typeof ContractModule>();
  return {
    ...m,
    executionContractProblem: (...a: Parameters<typeof m.executionContractProblem>) => {
      const p = m.executionContractProblem(...a);
      return p === "execution_contract_unavailable" ? null : p;
    },
  };
});

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * MOVER LEAD: motor antigo × motor novo, no MESMO cenário.
 *
 * O antigo grava pelo escritor de etapa da casa (`moveLeadHandler`, via REST/PostgREST — por isso esta
 * prova precisa do Supabase local de pé). O novo grava dentro do diário, em SQL. Cada cenário cria
 * dois negócios idênticos (um para cada motor), move os dois para a mesma etapa e compara o que ficou
 * no banco. Sem `REST_URL`/`REST_SERVICE_KEY` (o Postgres efêmero do `pnpm test:db` não tem
 * PostgREST), o arquivo se pula inteiro.
 *
 * Como rodar: ver o handoff (entrada 2026-10-29, "mover lead antigo × novo").
 */
const REST = Boolean(process.env.REST_URL && process.env.REST_SERVICE_KEY);
const suite = REST ? describe : describe.skip;

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 6,
});
const adapter = createPgAdminClient(pool);
const journal = new PgExecutionJournal(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const rest = () =>
  createClient(process.env.REST_URL ?? "http://127.0.0.1:1", process.env.REST_SERVICE_KEY ?? "x", {
    auth: { persistSession: false },
  });

const nota = (...partes: unknown[]) =>
  process.stderr.write(`${partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}
`);

type Etapa = "aberta" | "aberta2" | "ganha" | "perdida" | "outro_funil";

/** Funis e etapas do cenário (por nome estável; os ids mudam a cada rodada). */
async function mundo() {
  const id = () => randomUUID();
  const funil = id(),
    outroFunil = id();
  const etapas: Record<Etapa, string> = {
    aberta: id(),
    aberta2: id(),
    ganha: id(),
    perdida: id(),
    outro_funil: id(),
  };
  const slug = randomUUID().slice(0, 8);
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil A',$3),($4,$2,'Funil B',$5)",
    [funil, GOV_ORG, `a-${slug}`, outroFunil, `b-${slug}`],
  );
  const e = (key: Etapa, funilId: string, pos: number, extra = "") =>
    pool.query(
      `insert into crm_stages(id,organization_id,pipeline_id,name,slug,position${extra ? ",is_won,is_lost" : ""})
       values($1,$2,$3,$4,$5,$6${extra ? `,${extra}` : ""})`,
      [etapas[key], GOV_ORG, funilId, `Etapa ${key}`, `${key}-${slug}`, pos],
    );
  await e("aberta", funil, 1000);
  await e("aberta2", funil, 2000);
  await e("ganha", funil, 3000, "true,false");
  await e("perdida", funil, 4000, "false,true");
  await e("outro_funil", outroFunil, 1000);
  return { funil, etapas };
}

type Mundo = Awaited<ReturnType<typeof mundo>>;

async function negocio(
  m: Mundo,
  opts: { etapa?: Etapa; pessoal?: boolean; motivoPerda?: string } = {},
) {
  const contact = randomUUID(),
    lead = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name,is_personal) values($1,$2,'Ana','Ana',$3)",
    [contact, GOV_ORG, opts.pessoal ?? false],
  );
  const etapa = opts.etapa ?? "aberta";
  await pool.query(
    `insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage${
      opts.motivoPerda ? ",lost_reason" : ""
    })
     values($1,$2,$3,$4,$5,'Negócio',500${opts.motivoPerda ? ",$6" : ""})`,
    [lead, GOV_ORG, contact, m.funil, m.etapas[etapa], ...(opts.motivoPerda ? [opts.motivoPerda] : [])],
  );
  return { contact, lead };
}

type Config = { stage_id: string; lost_reason?: string; won_reason?: string };

type Resultado = {
  recusa: string | null;
  lead: {
    etapa: string | null;
    posicao: number | null;
    status: string | null;
    lost_reason: string | null;
    won_reason: string | null;
  } | null;
  atividades: { type: string; reason: string | null; actor_kind: string | null }[];
  eventos: string[];
  auditoria: string[];
};

async function observar(m: Mundo, lead: string, recusa: string | null): Promise<Resultado> {
  const nome = (id: string | null) =>
    id === null ? null : (Object.entries(m.etapas).find(([, v]) => v === id)?.[0] ?? id);
  const l = (
    await pool.query(
      "select stage_id,position_in_stage,status,lost_reason,won_reason from crm_leads where organization_id=$1 and id=$2",
      [GOV_ORG, lead],
    )
  ).rows[0];
  const atividades = (
    await pool.query(
      "select type,reason,actor_kind from crm_lead_activities where organization_id=$1 and lead_id=$2 order by performed_at",
      [GOV_ORG, lead],
    )
  ).rows;
  const eventos = (
    await pool.query(
      "select event_type from event_log where organization_id=$1 and entity_id=$2 order by created_at",
      [GOV_ORG, lead],
    )
  ).rows.map((r) => r.event_type as string);
  const auditoria = (
    await pool.query(
      "select action from api_audit_log where organization_id=$1 and resource_id=$2 order by created_at",
      [GOV_ORG, lead],
    )
  ).rows.map((r) => r.action as string);
  return {
    recusa,
    lead: l
      ? {
          etapa: nome(l.stage_id),
          posicao: l.position_in_stage === null ? null : Number(l.position_in_stage),
          status: l.status,
          lost_reason: l.lost_reason,
          won_reason: l.won_reason,
        }
      : null,
    atividades: atividades.map((a) => ({
      type: a.type,
      // o nome das etapas é igual nos dois mundos; ids não entram.
      reason: a.reason,
      actor_kind: a.actor_kind,
    })),
    eventos,
    auditoria,
  };
}

async function pelaAntiga(m: Mundo, n: { contact: string; lead: string }, cfg: Config) {
  let recusa: string | null = null;
  try {
    const db = createSupabaseAdminClient(rest());
    await db.moverLeadNoFunil!({
      organization_id: GOV_ORG,
      contact_id: n.contact,
      enrollment_id: randomUUID(),
      config: { stage_id: cfg.stage_id, ...(cfg.lost_reason ? { lost_reason: cfg.lost_reason } : {}) },
    } as never);
  } catch (error) {
    recusa = (error as { code?: string; message?: string }).code ?? (error as Error).message;
  }
  return observar(m, n.lead, recusa);
}

async function pelaNova(m: Mundo, n: { contact: string; lead: string }, cfg: Config) {
  const run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, n.contact);
  const graph = {
    execution_contract: 1,
    nodes: [
      { id: "mv", type: "move_lead", label: "Mover", position: { x: 0, y: 0 }, config: cfg },
      { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e", source: "mv", target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [
    version,
    GOV_ORG,
    graph,
  ]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Mover ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until,lead_id)
     values($1,$2,$3,$4,$5,$6,$7,1,'mv','active',now()-interval '1 second',now()+interval '2 minutes',$8)`,
    [run, GOV_ORG, flow, version, n.contact, origin.conversation_id, origin, n.lead],
  );
  let recusa: string | null = null;
  try {
    const scope = (await adapter.loadEnrollmentById(GOV_ORG, run))!;
    const begun = await journal.begin(scope, { contact_id: n.contact });
    if (begun.kind !== "ready") throw new Error(`begin_${begun.kind}`);
    await journal.completeMove(scope, begun.handle);
  } catch (error) {
    recusa = (error as { code?: string; message?: string }).code ?? (error as Error).message;
  }
  return observar(m, n.lead, recusa);
}

/** Roda o mesmo cenário nos dois motores, cada um no seu negócio idêntico. */
async function cenario(
  _m: Mundo,
  inicio: { etapa?: Etapa; pessoal?: boolean; motivoPerda?: string },
  destino: Etapa,
  extra: { lost_reason?: string; won_reason?: string } = {},
) {
  // Um funil/etapas PRÓPRIO para cada motor: a posição do card depende de quem já está na coluna, e o
  // segundo a mover veria o primeiro. Os nomes das etapas são iguais nos dois mundos.
  const mundoDoAntigo = await mundo();
  const mundoDoNovo = await mundo();
  const a = await negocio(mundoDoAntigo, inicio);
  const b = await negocio(mundoDoNovo, inicio);
  return {
    antigo: await pelaAntiga(mundoDoAntigo, a, { stage_id: mundoDoAntigo.etapas[destino], ...extra }),
    novo: await pelaNova(mundoDoNovo, b, { stage_id: mundoDoNovo.etapas[destino], ...extra }),
  };
}

suite("mover lead: motor antigo × motor novo (mesmo cenário, dois negócios idênticos)", () => {
  let m: Mundo;
  beforeAll(async () => {
    m = await mundo();
  });

  it("aberta → aberta: mesma etapa de destino, mesma posição, mesmo status e mesma atividade", async () => {
    const { antigo, novo } = await cenario(m, {}, "aberta2");
    expect(novo.recusa).toBeNull();
    expect(antigo.recusa).toBeNull();
    expect(novo.lead).toEqual(antigo.lead);
    expect(novo.atividades.map((a) => [a.type, a.reason])).toEqual(
      antigo.atividades.map((a) => [a.type, a.reason]),
    );
  });

  it("evento e auditoria: o novo emite lead.stage_changed como o antigo", async () => {
    const { antigo, novo } = await cenario(m, {}, "aberta2");
    expect(novo.eventos).toEqual(antigo.eventos);
    nota("[auditoria] antigo:", antigo.auditoria, "novo:", novo.auditoria);
    nota("[atividade.actor_kind] antigo:", antigo.atividades.map((a) => a.actor_kind), "novo:", novo.atividades.map((a) => a.actor_kind));
  });

  it("→ etapa de perda COM motivo configurado: mesmo resultado", async () => {
    const { antigo, novo } = await cenario(m, {}, "perdida", { lost_reason: "price" });
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    expect(novo.lead?.status).toBe("lost");
    expect(novo.lead).toEqual(antigo.lead);
  });

  it("→ etapa de perda SEM motivo: os dois recusam", async () => {
    const { antigo, novo } = await cenario(m, {}, "perdida");
    nota("[perda sem motivo] antigo:", antigo.recusa, "novo:", novo.recusa);
    expect(antigo.recusa).not.toBeNull();
    expect(novo.recusa).not.toBeNull();
    expect(novo.lead).toEqual(antigo.lead);
  });

  it("DIVERGÊNCIA CONHECIDA — → ganho com 'motivo do ganho' configurado: o novo grava, o antigo ignora o campo", async () => {
    const { antigo, novo } = await cenario(m, {}, "ganha", { won_reason: "indicação" });
    nota("[ganho com motivo] antigo:", JSON.stringify(antigo.lead), antigo.recusa, "| novo:", JSON.stringify(novo.lead), novo.recusa);
    expect(antigo.recusa).toBeNull();
    expect(novo.recusa).toBeNull();
    // O antigo só repassa `lost_reason` ao escritor de etapa (engine.ts, moverLeadNoFunil): o motivo
    // de ganho configurado no bloco nunca chega. O novo o grava. Mantido assim de propósito: gravar
    // o que o bloco diz que grava é o comportamento certo, e o antigo é que o ignorava.
    expect(antigo.lead?.won_reason).toBeNull();
    expect(novo.lead?.won_reason).toBe("indicação");
    expect({ ...novo.lead, won_reason: null }).toEqual(antigo.lead);
  });

  it("→ etapa de ganho sem motivo configurado: mesmo resultado", async () => {
    const { antigo, novo } = await cenario(m, {}, "ganha");
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.lead).toEqual(antigo.lead);
  });

  it("negócio perdido movido para etapa aberta (reabrir): mesmo resultado", async () => {
    const { antigo, novo } = await cenario(m, { etapa: "perdida", motivoPerda: "price" }, "aberta");
    nota("[reabrir] antigo:", JSON.stringify(antigo.lead), antigo.recusa, "| novo:", JSON.stringify(novo.lead), novo.recusa);
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.lead).toEqual(antigo.lead);
  });

  it("negócio que já está na etapa de destino: mesmo resultado", async () => {
    const { antigo, novo } = await cenario(m, {}, "aberta");
    nota("[mesma etapa] antigo:", JSON.stringify(antigo.lead), antigo.recusa, antigo.atividades.length, "| novo:", JSON.stringify(novo.lead), novo.recusa, novo.atividades.length);
    expect(novo.recusa).toBe(antigo.recusa);
    expect(novo.lead).toEqual(antigo.lead);
  });

  it("etapa de OUTRO funil: nenhum dos dois move o card", async () => {
    const { antigo, novo } = await cenario(m, {}, "outro_funil");
    nota("[outro funil] antigo:", JSON.stringify(antigo.lead), antigo.recusa, "| novo:", JSON.stringify(novo.lead), novo.recusa);
    expect(novo.lead?.etapa).toBe("aberta");
    expect(antigo.lead?.etapa).toBe("aberta");
  });

  it("contato pessoal: nenhum dos dois move o card", async () => {
    const { antigo, novo } = await cenario(m, { pessoal: true }, "aberta2");
    nota("[pessoal] antigo:", JSON.stringify(antigo.lead), antigo.recusa, "| novo:", JSON.stringify(novo.lead), novo.recusa);
    expect(novo.lead?.etapa).toBe("aberta");
    expect(antigo.lead?.etapa).toBe("aberta");
  });
});
