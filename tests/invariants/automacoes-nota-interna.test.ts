import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Nota interna (Fase 5) no motor novo, com Postgres real: grava no destino ESCOLHIDO (linha do tempo do negócio ou
 * notas da conversa), uma vez só, com o texto resolvido; variável sem valor falha com explicação.
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
    throw new Error("nota_interna_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodar(config: { destino: "lead_timeline" | "conversation_notes"; texto: string }) {
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
    nodes: [
      no("mapa", "map_data", { fields: [{ name: "motivo", value: "orçamento parado", type: "text" }] }),
      no("nota", "add_note", config),
      no("fim", "end", { outcome: "converted" }),
    ],
    edges: [
      { id: "e1", source: "mapa", target: "nota", condition: { type: "always" } },
      { id: "e2", source: "nota", target: "fim", condition: { type: "always" } },
    ],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Nota ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'mapa','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  for (let i = 0; i < 5; i++) {
    const scope = await adapter.loadEnrollmentById(GOV_ORG, run);
    if (!scope || scope.status !== "active" || scope.current_node_id === "fim") break;
    await avancarEnrollmentAtivo(deps, scope);
    await pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1 and status='active'",
      [run],
    );
  }
  const noNegocio = (
    await pool.query("select reason from crm_lead_activities where organization_id=$1 and lead_id=$2 and type='note'", [GOV_ORG, lead])
  ).rows as Array<{ reason: string }>;
  const naConversa = (
    await pool.query("select body,created_by_name from conversation_notes where organization_id=$1 and conversation_id=$2", [
      GOV_ORG,
      origin.conversation_id,
    ])
  ).rows as Array<{ body: string; created_by_name: string }>;
  const passo = (
    await pool.query(
      `select s.status, a.error_snapshot from followup_execution_steps s
         join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='nota' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; error_snapshot: { message?: string } | null };
  return { noNegocio, naConversa, passo };
}

describe("Nota interna no diário (motor novo, Postgres real)", () => {
  it("destino negócio: uma nota na linha do tempo, com a variável resolvida, e nada na conversa", async () => {
    const { noNegocio, naConversa, passo } = await rodar({ destino: "lead_timeline", texto: "Atenção: {{nodes.mapa.fields.motivo}}" });
    expect(passo.status).toBe("succeeded");
    expect(noNegocio.map((n) => n.reason)).toEqual(["Atenção: orçamento parado"]);
    expect(naConversa).toEqual([]);
  });

  it("destino conversa: uma nota interna na conversa, e nada no negócio", async () => {
    const { noNegocio, naConversa } = await rodar({ destino: "conversation_notes", texto: "Retomar contato" });
    expect(naConversa).toEqual([{ body: "Retomar contato", created_by_name: "Automação" }]);
    expect(noNegocio).toEqual([]);
  });

  it("variável sem valor: falha com a explicação e não grava nota cortada", async () => {
    const { noNegocio, passo } = await rodar({ destino: "lead_timeline", texto: "Motivo: {{nodes.mapa.fields.nao_existe}}" });
    expect(passo.status).toBe("failed");
    expect(passo.error_snapshot?.message).toContain("nao_existe");
    expect(noNegocio).toEqual([]);
  });
});
