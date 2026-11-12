import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Remover tags (Fase 5), motor novo e Postgres real: o bloco de tag com `acao: "remove"` tira só as tags pedidas
 * (as outras ficam), grava a saída com `removed_tags` e NÃO emite `lead.tag_added` (nada foi adicionado).
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
    throw new Error("remover_tags_must_not_enqueue");
  },
};
const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

describe("remover tags (motor novo, Postgres real)", () => {
  it("tira só as pedidas, guarda removed_tags e não emite tag_added", async () => {
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
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage,tags) values($1,$2,$3,$4,$5,'Negócio',500,$6)",
      [lead, GOV_ORG, contact, pipeline, stage, ["quente", "orcamento", "vip"]],
    );
    const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
    const g = {
      execution_contract: 1,
      nodes: [no("tag", "edit_lead_tag", { tags: ["orcamento", "nao_tem"], acao: "remove" }), no("fim", "end", { outcome: "converted" })],
      edges: [{ id: "e1", source: "tag", target: "fim", condition: { type: "always" } }],
    };
    await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
    await pool.query(
      "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
      [flow, GOV_ORG, version, `Tags ${run}`],
    );
    await pool.query(
      `insert into followup_enrollments
       (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
       values($1,$2,$3,$4,$5,$6,$7,'tag','active',now()-interval '1 second',now()+interval '2 minutes')`,
      [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
    );
    const scope = (await adapter.loadEnrollmentById(GOV_ORG, run))!;
    await avancarEnrollmentAtivo(deps, scope);
    const tags = (await pool.query("select tags from crm_leads where id=$1", [lead])).rows[0].tags as string[];
    expect(tags).toEqual(["quente", "vip"]);
    const saida = (
      await pool.query(
        `select a.output_snapshot from followup_execution_steps s join followup_execution_attempts a on a.step_id=s.id
          where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='tag' order by a.attempt_no desc limit 1`,
        [GOV_ORG, run],
      )
    ).rows[0]?.output_snapshot as { removed_tags?: string[]; added_tags: string[] };
    expect(saida).toMatchObject({ added_tags: [], removed_tags: ["orcamento"] });
    const eventos = Number(
      (await pool.query("select count(*) from event_log where entity_id=$1 and event_type='lead.tag_added'", [lead])).rows[0].count,
    );
    expect(eventos).toBe(0);
  });
});
