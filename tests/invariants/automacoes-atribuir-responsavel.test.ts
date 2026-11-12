import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_VIEWER, seedGov } from "./gov-helpers";

/**
 * Atribuir responsável (Fase 5) no motor novo, com Postgres real: troca o dono do NEGÓCIO (não da conversa), registra
 * atividade e auditoria uma vez só, e recusa quem não é atendente ativo (viewer) com explicação.
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
    throw new Error("atribuir_responsavel_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodar(usuario: string) {
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
    "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage,owner_user_id,owner_kind) values($1,$2,$3,$4,$5,'Negócio',500,$6,'user')",
    [lead, GOV_ORG, contact, pipeline, stage, GOV_AGENT_A],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const g = {
    execution_contract: 1,
    nodes: [no("dono", "assign_lead_owner", { usuario_id: usuario }), no("fim", "end", { outcome: "converted" })],
    edges: [{ id: "e1", source: "dono", target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Dono ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'dono','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  expect(scope.execution_contract).toBe(1);
  await avancarEnrollmentAtivo(deps, scope);
  // replay do mesmo passo (tick repetido) não duplica nada
  const depois = await adapter.loadEnrollmentById(GOV_ORG, run);
  if (depois && depois.current_node_id === "dono" && depois.status === "active") await avancarEnrollmentAtivo(deps, depois);
  const negocio = (await pool.query("select owner_user_id,owner_kind from crm_leads where id=$1", [lead])).rows[0] as {
    owner_user_id: string;
    owner_kind: string;
  };
  const atividades = Number(
    (
      await pool.query(
        "select count(*) from crm_lead_activities where organization_id=$1 and lead_id=$2 and reason='Trocou o responsável'",
        [GOV_ORG, lead],
      )
    ).rows[0].count,
  );
  const passo = (
    await pool.query(
      `select s.status, a.output_snapshot, a.error_snapshot from followup_execution_steps s
         join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='dono' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; output_snapshot: unknown; error_snapshot: { message?: string } | null };
  const conversa = (await pool.query("select assigned_to_user_id from conversations where id=$1", [origin.conversation_id]))
    .rows[0] as { assigned_to_user_id: string | null } | undefined;
  return { negocio, atividades, passo, conversa, lead };
}

describe("Atribuir responsável no diário (motor novo, Postgres real)", () => {
  it("troca o dono do negócio, uma atividade só, e a saída diz de quem para quem", async () => {
    const { negocio, atividades, passo, lead } = await rodar(GOV_AGENT_B);
    expect(negocio).toEqual({ owner_user_id: GOV_AGENT_B, owner_kind: "user" });
    expect(atividades).toBe(1);
    expect(passo.output_snapshot).toEqual({ lead_id: lead, previous_owner_user_id: GOV_AGENT_A, owner_user_id: GOV_AGENT_B });
  });

  it("não mexe no responsável pela conversa", async () => {
    const { conversa } = await rodar(GOV_AGENT_B);
    expect(conversa?.assigned_to_user_id ?? null).not.toBe(GOV_AGENT_B);
  });

  it("viewer não é atendente: falha com explicação e o dono fica como estava", async () => {
    const { negocio, passo, atividades } = await rodar(GOV_VIEWER);
    expect(passo.status).toBe("failed");
    expect(passo.error_snapshot?.message).toContain("atendente ativo");
    expect(negocio.owner_user_id).toBe(GOV_AGENT_A);
    expect(atividades).toBe(0);
  });
});
