import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo, createSupabaseAdminClient } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Condição por PRODUTO do negócio (fluxo "entrou em Ganhos → se Coleta na Prática, X; se Micro na
 * Prática, Y"), no motor novo e com Postgres real: os produtos vêm de `crm_lead_products`, a decisão
 * é gravada no diário e a inscrição segue pelo ramo do produto.
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
    throw new Error("condicao_por_produto_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({
  id,
  type,
  label: id,
  position: { x: 0, y: 0 },
  config,
});

const grafo = {
  execution_contract: 1,
  nodes: [
    no("por_produto", "condition", {
      combinator: "and",
      branching: "per_check",
      checks: [
        { id: "coleta", label: "Coleta na Prática", field: "product", op: "contains", value: "Coleta na Prática" },
        { id: "micro", label: "Micro na Prática", field: "product", op: "contains", value: "Micro na Prática" },
      ],
    }),
    no("msg_x", "end", { outcome: "converted" }),
    no("msg_y", "end", { outcome: "custom" }),
    no("nenhum", "end", { outcome: "exhausted" }),
  ],
  edges: [
    { id: "e1", source: "por_produto", target: "msg_x", condition: { type: "branch", branch_id: "coleta" } },
    { id: "e2", source: "por_produto", target: "msg_y", condition: { type: "branch", branch_id: "micro" } },
    { id: "e3", source: "por_produto", target: "nenhum", condition: { type: "always" } },
  ],
};

async function rodar(produtos: string[]) {
  const contact = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    version = randomUUID(),
    flow = randomUUID(),
    run = randomUUID(),
    slug = randomUUID().slice(0, 8);
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Vendas',$3)", [pipeline, GOV_ORG, `v-${slug}`]);
  await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Ganhos',$4,1000)", [stage, GOV_ORG, pipeline, `g-${slug}`]);
  await pool.query(
    "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage) values($1,$2,$3,$4,$5,'Negócio',500)",
    [lead, GOV_ORG, contact, pipeline, stage],
  );
  for (const nome of produtos) {
    await pool.query(
      "insert into crm_lead_products(organization_id,lead_id,nome,quantidade,preco_unitario_cents) values($1,$2,$3,1,10000)",
      [GOV_ORG, lead, nome],
    );
  }
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, grafo]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Produto ${run}`],
  );
  // contrato 0 de propósito: é o gatilho 0710 que faz a inscrição nascer no motor novo, com o lead.
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'por_produto','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  expect(scope.execution_contract).toBe(1);
  expect(scope.lead_id).toBe(lead);
  await avancarEnrollmentAtivo(deps, scope);
  const depois = (
    await pool.query("select current_node_id,status from followup_enrollments where organization_id=$1 and id=$2", [GOV_ORG, run])
  ).rows[0] as { current_node_id: string; status: string };
  const facts = await adapter.loadLeadFacts(GOV_ORG, contact, { execution_contract: 1, lead_id: lead });
  return { depois, facts, contact, lead };
}

describe("condição por produto do negócio (motor novo, Postgres real)", () => {
  it("negócio com Coleta na Prática (qualquer variante) segue pela mensagem X", async () => {
    const { depois, facts } = await rodar(["Coleta na Prática SSA"]);
    expect(facts.products).toEqual(["Coleta na Prática SSA"]);
    expect(depois.current_node_id).toBe("msg_x");
  });

  it("negócio com Micro na Prática segue pela mensagem Y", async () => {
    const { depois } = await rodar(["Micro na Prática"]);
    expect(depois.current_node_id).toBe("msg_y");
  });

  it("negócio com outro produto, ou sem produto, cai no ramo 'nenhum'", async () => {
    expect((await rodar(["Hemato na Prática"])).depois.current_node_id).toBe("nenhum");
    expect((await rodar([])).depois.current_node_id).toBe("nenhum");
  });

  it("com os dois produtos vence a primeira regra da lista (Coleta)", async () => {
    expect((await rodar(["Micro na Prática", "Coleta na Prática VCA"])).depois.current_node_id).toBe("msg_x");
  });
});

// O adaptador de PRODUÇÃO lê pela REST (PostgREST). Só roda com o Supabase local de pé.
const REST = Boolean(process.env.REST_URL && process.env.REST_SERVICE_KEY);
(REST ? describe : describe.skip)("leitor REST (produção) devolve os produtos do negócio", () => {
  it("loadLeadFacts pela REST traz os nomes dos produtos do lead fixado", async () => {
    const { contact, lead } = await rodar(["Coleta na Prática SSA", "Micro na Prática"]);
    const rest = createClient(process.env.REST_URL!, process.env.REST_SERVICE_KEY!, { auth: { persistSession: false } });
    const facts = await createSupabaseAdminClient(rest).loadLeadFacts(GOV_ORG, contact, { execution_contract: 1, lead_id: lead });
    expect([...(facts.products ?? [])].sort()).toEqual(["Coleta na Prática SSA", "Micro na Prática"]);
  });
});
