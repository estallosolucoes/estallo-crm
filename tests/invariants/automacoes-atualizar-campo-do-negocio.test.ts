import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Atualizar campo do negócio (Fase 5), motor novo e Postgres real: valor do negócio vira centavos; campo do catálogo é
 * convertido pelo tipo; opção inexistente falha com explicação e nada é gravado; replay não duplica a atividade.
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
    throw new Error("campo_do_negocio_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodar(config: { alvo: "custom_field" | "deal_value" | "contact_field"; chave: string; valor: string }) {
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
      no("mapa", "map_data", { fields: [{ name: "total", value: "1.500,00", type: "text" }] }),
      no("nota", "update_lead_field", config),
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
  const negocio = (await pool.query("select value_cents,custom_fields from crm_leads where id=$1", [lead])).rows[0] as {
    value_cents: number | null;
    custom_fields: Record<string, unknown> | null;
  };
  const atividades = Number(
    (await pool.query("select count(*) from crm_lead_activities where lead_id=$1 and type='lead_edited'", [lead])).rows[0].count,
  );
  const passo = (
    await pool.query(
      `select s.status, a.error_snapshot from followup_execution_steps s
         join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='nota' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; error_snapshot: { message?: string } | null };
  const contato = (await pool.query("select custom_fields from contacts where id=$1", [contact])).rows[0] as {
    custom_fields: Record<string, unknown> | null;
  };
  return { negocio, atividades, passo, contato };
}

describe("Atualizar campo do negócio (motor novo, Postgres real)", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into custom_field_definitions(organization_id,entity,key,label,type,options) values
       ($1,'lead','orcamento_inv','Orçamento','number','[]'),
       ($1,'lead','plano_inv','Plano','select','[{"value":"a","label":"Plano A"}]'),
       ($1,'contact','aniversario_inv','Aniversário','date','[]')
       on conflict (organization_id,entity,key) do nothing`,
      [GOV_ORG],
    );
  });

  it("valor do negócio, vindo do Mapear dados, vira centavos; uma atividade só", async () => {
    const { negocio, atividades, passo } = await rodar({ alvo: "deal_value", chave: "", valor: "{{nodes.mapa.fields.total}}" });
    expect(passo.status).toBe("succeeded");
    expect(Number(negocio.value_cents)).toBe(150000); // bigint chega como texto pelo driver pg
    expect(atividades).toBe(1);
  });

  it("campo numérico do catálogo é convertido e mesclado sem apagar os outros campos", async () => {
    const { negocio } = await rodar({ alvo: "custom_field", chave: "orcamento_inv", valor: "2.300,50" });
    expect(negocio.custom_fields?.orcamento_inv).toBe(2300.5);
  });

  it("opção que não existe na lista: falha com explicação e não grava", async () => {
    const { negocio, passo, atividades } = await rodar({ alvo: "custom_field", chave: "plano_inv", valor: "Plano Z" });
    expect(passo.status).toBe("failed");
    expect(passo.error_snapshot?.message).toContain("Plano Z");
    expect(negocio.custom_fields?.plano_inv).toBeUndefined();
    expect(atividades).toBe(0);
  });
  it("campo do CONTATO (catálogo de contato): data convertida e gravada no contato, não no negócio", async () => {
    const { contato, negocio, passo } = await rodar({ alvo: "contact_field", chave: "aniversario_inv", valor: "15/03/1990" });
    expect(passo.status).toBe("succeeded");
    expect(contato.custom_fields?.aniversario_inv).toBe("1990-03-15");
    expect(negocio.custom_fields?.aniversario_inv).toBeUndefined();
  });
});
