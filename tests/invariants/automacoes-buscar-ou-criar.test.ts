import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Buscar ou criar contato/negócio + «Aplicar em» (Fase 5), motor novo e Postgres real: a execução continua presa ao
 * seu contato, e um bloco seguinte age sobre o registro que o anterior entregou — referenciado pela variável, como
 * no n8n. O negócio da execução não é tocado.
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
    throw new Error("lookup_must_not_enqueue");
  },
};
const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });
const telefone = () => `+55 11 9${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function cenario(nodes: ReturnType<typeof no>[]) {
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
    "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage) values($1,$2,$3,$4,$5,'Da execução',500)",
    [lead, GOV_ORG, contact, pipeline, stage],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const grafo = (p: string, s: string) => {
    const ns = nodes.map((n) => JSON.parse(JSON.stringify(n).split("$FUNIL").join(p).split("$ETAPA").join(s)));
    return {
      execution_contract: 1,
      nodes: [...ns, no("fim", "end", { outcome: "converted" })],
      edges: [...ns, { id: "fim" }].slice(1).map((alvo, i) => ({ id: `e${i}`, source: ns[i]!.id, target: alvo.id, condition: { type: "always" } })),
    };
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, grafo(pipeline, stage)]);
  await pool.query("insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)", [flow, GOV_ORG, version, `Busca ${run}`]);
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,lead_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, lead, origin, nodes[0]!.id],
  );
  for (let i = 0; i < nodes.length + 1; i++) {
    const e = (await pool.query("select status,current_node_id from followup_enrollments where id=$1", [run])).rows[0];
    if (e.status !== "active" || e.current_node_id === "fim") break;
    await pool.query("update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1", [run]);
    await avancarEnrollmentAtivo(deps, (await adapter.loadEnrollmentById(GOV_ORG, run))!);
  }
  const saidas = Object.fromEntries(
    (
      await pool.query(
        `select s.node_id, a.output_snapshot, a.error_snapshot from followup_execution_steps s join followup_execution_attempts a on a.step_id=s.id
          where s.organization_id=$1 and s.enrollment_id=$2 order by a.attempt_no`,
        [GOV_ORG, run],
      )
    ).rows.map((r) => [r.node_id, r]),
  );
  return { run, lead, pipeline, stage, saidas };
}

describe("buscar ou criar + «Aplicar em» (motor novo, Postgres real)", () => {
  it("cria contato e negócio, e o bloco seguinte grava a tag no negócio NOVO — o da execução fica intacto", async () => {
    const fone = telefone();
    const { lead, pipeline, stage, saidas } = await cenario([
      no("c", "find_or_create_contact", { busca: "phone", valor: fone, criar: true, nome: "Bruno" }),
      no("l", "find_or_create_lead", { contato: "{{nodes.c.contact_id}}", pipeline_id: "$FUNIL", stage_id: "$ETAPA", titulo: "Pedido de {{nodes.c.contact_id}}", criar: true }),
      no("tag", "edit_lead_tag", { tags: ["indicado"], aplicar_em: "{{nodes.l.lead_id}}" }),
    ]);
    expect(saidas.c.output_snapshot).toMatchObject({ encontrado: false, criado: true });
    const contato = (await pool.query("select name,phone_number,source from contacts where id=$1", [saidas.c.output_snapshot.contact_id])).rows[0];
    expect(contato).toEqual({ name: "Bruno", phone_number: canonicalPhoneBR(fone), source: "automation" });
    const novo = saidas.l.output_snapshot.lead_id as string;
    expect(saidas.l.output_snapshot).toMatchObject({ contact_id: saidas.c.output_snapshot.contact_id, criado: true });
    const negocio = (await pool.query("select pipeline_id,stage_id,status,tags,contact_id from crm_leads where id=$1", [novo])).rows[0];
    expect(negocio).toMatchObject({ pipeline_id: pipeline, stage_id: stage, status: "open", tags: ["indicado"] });
    expect((await pool.query("select tags from crm_leads where id=$1", [lead])).rows[0].tags).toEqual([]);
    const atividade = (await pool.query("select 1 from crm_lead_activities where lead_id=$1 and type='lead_created'", [novo])).rows;
    expect(atividade).toHaveLength(1);
  });

  it("contato que já existe é achado, não duplicado; negócio aberto no funil é achado, não duplicado", async () => {
    const fone = telefone();
    const existente = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Carla',$3)", [existente, GOV_ORG, canonicalPhoneBR(fone)]);
    const { saidas, lead } = await cenario([
      no("c", "find_or_create_contact", { busca: "phone", valor: fone, criar: true, nome: "" }),
      no("l", "find_or_create_lead", { contato: "", pipeline_id: "$FUNIL", stage_id: "$ETAPA", titulo: "", criar: true }),
    ]);
    expect(saidas.c.output_snapshot).toEqual({ contact_id: existente, encontrado: true, criado: false });
    expect(saidas.l.output_snapshot).toMatchObject({ lead_id: lead, encontrado: true, criado: false });
    expect((await pool.query("select count(*)::int as n from contacts where organization_id=$1 and phone_number=$2", [GOV_ORG, canonicalPhoneBR(fone)])).rows[0].n).toBe(1);
  });

  it("«Aplicar em» sem valor (o Buscar não achou e não criou) falha explicado, sem tocar em nada", async () => {
    const { saidas, lead } = await cenario([
      no("c", "find_or_create_contact", { busca: "email", valor: `ninguem-${randomUUID()}@exemplo.com`, criar: false, nome: "" }),
      no("tag", "edit_lead_tag", { tags: ["x"], destino: "contato", aplicar_em: "{{nodes.c.contact_id}}" }),
    ]);
    expect(saidas.c.output_snapshot).toEqual({ contact_id: null, encontrado: false, criado: false });
    expect(saidas.tag.error_snapshot?.message).toContain("Aplicar em");
    expect((await pool.query("select tags from crm_leads where id=$1", [lead])).rows[0].tags).toEqual([]);
  });
});
