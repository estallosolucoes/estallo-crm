import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

// Migration 0710: toda inscrição nasce no contrato de execução da versão fixada, com o lead explícito.
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 4,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

const no = (id: string, type: string, config: object, y: number) => ({
  id,
  type,
  label: id,
  position: { x: 0, y },
  config,
});
const grafo = (contrato: boolean) => ({
  ...(contrato ? { execution_contract: 1 } : {}),
  nodes: [no("t", "wait", { duration_ms: 1000 }, 0), no("fim", "end", { outcome: "converted" }, 100)],
  edges: [{ id: "e", source: "t", target: "fim", condition: { type: "always" } }],
});

async function inscrever(opts: { contrato: boolean; leads?: number; inscricao?: { contract: 0 | 1; lead: string | null } }) {
  const contact = randomUUID(),
    version = randomUUID(),
    flow = randomUUID(),
    run = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const leads: string[] = [];
  if (opts.leads) {
    const pipeline = randomUUID(),
      stage = randomUUID(),
      slug = randomUUID().slice(0, 8);
    await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'F',$3)", [pipeline, GOV_ORG, `f-${slug}`]);
    await pool.query(
      "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'E',$4,1000)",
      [stage, GOV_ORG, pipeline, `e-${slug}`],
    );
    for (let i = 0; i < opts.leads; i++) {
      const id = randomUUID();
      leads.push(id);
      await pool.query(
        `insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage,updated_at)
         values($1,$2,$3,$4,$5,$6,500,now() + ($7 || ' seconds')::interval)`,
        [id, GOV_ORG, contact, pipeline, stage, `Negócio ${i}`, String(i)],
      );
    }
  }
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, grafo(opts.contrato)]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Herda ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,execution_contract,lead_id)
     values($1,$2,$3,$4,$5,$6,$7,'t','active',$8,$9)`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin, opts.inscricao?.contract ?? 0, opts.inscricao?.lead ?? null],
  );
  const row = (
    await pool.query("select execution_contract,lead_id from followup_enrollments where organization_id=$1 and id=$2", [GOV_ORG, run])
  ).rows[0] as { execution_contract: number; lead_id: string | null };
  return { row, leads };
}

describe("a inscrição herda o contrato da versão fixada (migration 0710)", () => {
  it("versão de contrato 1: a inscrição nasce no contrato 1 com o negócio mais recente do contato", async () => {
    const { row, leads } = await inscrever({ contrato: true, leads: 2 });
    expect(row.execution_contract).toBe(1);
    expect(row.lead_id).toBe(leads[1]); // o de updated_at maior
  });

  it("versão de contrato 1 e contato SEM negócio: contrato 1 com lead nulo (execução sem lead, explícita)", async () => {
    const { row } = await inscrever({ contrato: true });
    expect(row).toEqual({ execution_contract: 1, lead_id: null });
  });

  it("versão sem a chave (legada): a inscrição continua no contrato 0, sem lead", async () => {
    const { row } = await inscrever({ contrato: false, leads: 1 });
    expect(row).toEqual({ execution_contract: 0, lead_id: null });
  });

  it("inscrição que já traz contrato 1 e lead nulo fica como veio (não se escolhe lead por cima)", async () => {
    const { row } = await inscrever({ contrato: true, leads: 1, inscricao: { contract: 1, lead: null } });
    expect(row).toEqual({ execution_contract: 1, lead_id: null });
  });
});
