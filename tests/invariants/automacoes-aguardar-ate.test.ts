import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { alvoDaEsperaAte } from "@/lib/followup/espera-ate";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * «Aguardar até» (Fase 5) no motor novo, com Postgres real: o alvo é calculado no fuso da ORGANIZAÇÃO; data futura
 * estaciona a espera nesse instante; data já passada segue para o próximo bloco sem travar.
 */
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 4,
});
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const deps = {
  db: adapter,
  clock: () => new Date(),
  enqueueJob: async () => {
    throw new Error("aguardar_ate_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodar(config: { hora: string; data?: string }) {
  const contact = randomUUID(),
    version = randomUUID(),
    flow = randomUUID(),
    run = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    slug = randomUUID().slice(0, 8);
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Vendas',$3)", [pipeline, GOV_ORG, `v-${slug}`]);
  await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo',$4,1000)", [stage, GOV_ORG, pipeline, `n-${slug}`]);
  await pool.query(
    "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage) values($1,$2,$3,$4,$5,'Negócio',500)",
    [lead, GOV_ORG, contact, pipeline, stage],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const g = {
    execution_contract: 1,
    nodes: [no("espera", "wait", { mode: "until", ...config }), no("fim", "end", { outcome: "converted" })],
    edges: [{ id: "e1", source: "espera", target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Até ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'espera','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  expect(scope.execution_contract).toBe(1);
  await avancarEnrollmentAtivo(deps, scope);
  const inscricao = (await pool.query("select current_node_id,next_eval_at from followup_enrollments where id=$1", [run]))
    .rows[0] as { current_node_id: string; next_eval_at: Date | null };
  const tentativa = (
    await pool.query(
      `select a.status, a.next_eval_at from followup_execution_steps s join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='espera' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; next_eval_at: Date | null } | undefined;
  return { inscricao, tentativa };
}

describe("Aguardar até data/horário (motor novo, Postgres real)", () => {
  it("data futura: a espera fica estacionada exatamente no instante do fuso da organização", async () => {
    const fuso = (await pool.query("select timezone from organizations where id=$1", [GOV_ORG])).rows[0].timezone as string;
    const config = { data: "2099-06-15", hora: "09:30" };
    const esperado = alvoDaEsperaAte(config, fuso, new Date());
    if (!esperado.ok) throw new Error("alvo inválido no teste");
    const { inscricao, tentativa } = await rodar(config);
    expect(inscricao.current_node_id).toBe("espera");
    expect(tentativa?.status).toBe("waiting");
    expect(new Date(tentativa!.next_eval_at!).toISOString()).toBe(esperado.alvo.toISOString());
  });

  it("data já passada: segue para o próximo bloco sem travar o fluxo", async () => {
    const { inscricao } = await rodar({ data: "2020-01-01", hora: "09:00" });
    expect(inscricao.current_node_id).toBe("fim");
  });
});
