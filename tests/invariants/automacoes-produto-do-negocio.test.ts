import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Produto do negócio (Fase 5), motor novo e Postgres real: acrescentar copia nome e preço do CATÁLOGO da organização
 * (o banco recalcula o valor do negócio); tirar remove os itens daquele produto; produto de outra organização falha.
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
    throw new Error("produto_must_not_enqueue");
  },
};
const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodar(config: { acao: "add" | "remove"; product_id: string; quantidade: number }, itensIniciais = 0) {
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
  for (let k = 0; k < itensIniciais; k++)
    await pool.query(
      "insert into crm_lead_products(organization_id,lead_id,product_id,nome,preco_unitario_cents,quantidade) values($1,$2,$3,'Coleta',25000,1)",
      [GOV_ORG, lead, config.product_id],
    );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const g = {
    execution_contract: 1,
    nodes: [no("prod", "lead_product", config), no("fim", "end", { outcome: "converted" })],
    edges: [{ id: "e1", source: "prod", target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
  await pool.query("insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)", [flow, GOV_ORG, version, `Produto ${run}`]);
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'prod','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  await avancarEnrollmentAtivo(deps, (await adapter.loadEnrollmentById(GOV_ORG, run))!);
  const itens = (await pool.query("select nome,preco_unitario_cents,quantidade from crm_lead_products where lead_id=$1", [lead])).rows;
  const valor = (await pool.query("select value_cents from crm_leads where id=$1", [lead])).rows[0].value_cents;
  const passo = (
    await pool.query(
      `select s.status, a.error_snapshot from followup_execution_steps s join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='prod' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; error_snapshot: { message?: string } | null };
  return { itens, valor, passo };
}

describe("produto do negócio (motor novo, Postgres real)", () => {
  const produto = randomUUID();
  beforeAll(async () => {
    await pool.query(
      "insert into catalog_products(id,organization_id,codigo,nome,preco_cents) values($1,$2,$3,'Coleta na Prática',25000) on conflict do nothing",
      [produto, GOV_ORG, `COL-${produto.slice(0, 6)}`],
    );
  });

  it("acrescentar copia nome e preço do catálogo, com a quantidade do bloco, e o valor do negócio é recalculado", async () => {
    const { itens, valor, passo } = await rodar({ acao: "add", product_id: produto, quantidade: 2 });
    expect(passo.status).toBe("succeeded");
    expect(itens).toEqual([{ nome: "Coleta na Prática", preco_unitario_cents: "25000", quantidade: 2 }]);
    expect(Number(valor)).toBe(50000);
  });

  it("tirar remove os itens daquele produto", async () => {
    const { itens } = await rodar({ acao: "remove", product_id: produto, quantidade: 1 }, 2);
    expect(itens).toEqual([]);
  });

  it("produto que não é do catálogo desta organização falha com explicação, sem gravar", async () => {
    const { itens, passo } = await rodar({ acao: "add", product_id: randomUUID(), quantidade: 1 });
    expect(passo.status).toBe("failed");
    expect(passo.error_snapshot?.message).toContain("catálogo");
    expect(itens).toEqual([]);
  });
});
