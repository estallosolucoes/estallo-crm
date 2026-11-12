import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_AGENT_A, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Recuperar a partir da falha (Fase 6), motor novo e Postgres real: a tarefa falha (negócio sem dono) e a execução
 * morre; corrigido o dono, a RECUPERAÇÃO vinculada (`recovery_kind = 'retry'`) começa no bloco que falhou, herda a
 * saída do Mapear dados da original (o título resolve) e o Mapear dados NÃO roda de novo. A original não muda.
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
    throw new Error("recuperar_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function rodarAteParar(run: string) {
  for (let i = 0; i < 5; i++) {
    const scope = await adapter.loadEnrollmentById(GOV_ORG, run);
    if (!scope || scope.status !== "active" || scope.current_node_id === "fim") return;
    await avancarEnrollmentAtivo(deps, scope);
    await pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1 and status='active'",
      [run],
    );
  }
}

describe("recuperar a partir da falha (motor novo, Postgres real)", () => {
  it("começa no bloco que falhou, herda as saídas e não repete o que já concluiu", async () => {
    const contact = randomUUID(),
      version = randomUUID(),
      flow = randomUUID(),
      original = randomUUID(),
      recuperacao = randomUUID(),
      lead = randomUUID(),
      pipeline = randomUUID(),
      stage = randomUUID(),
      slug = randomUUID().slice(0, 8);
    await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
    await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Vendas',$3)", [pipeline, GOV_ORG, `v-${slug}`]);
    await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo',$4,1000)", [stage, GOV_ORG, pipeline, `n-${slug}`]);
    // Sem dono: a tarefa «para o dono do negócio» não tem para quem ir — falha de configuração.
    await pool.query(
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage) values($1,$2,$3,$4,$5,'Negócio',500)",
      [lead, GOV_ORG, contact, pipeline, stage],
    );
    const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
    const g = {
      execution_contract: 1,
      nodes: [
        no("mapa", "map_data", { fields: [{ name: "assunto", value: "Retorno do orçamento", type: "text" }] }),
        no("tarefa", "internal_task", {
          titulo: "Ligar: {{nodes.mapa.fields.assunto}}",
          vence_em_dias: 0,
          atribuir_a: "dono_do_lead",
          prioridade: "medium",
        }),
        no("fim", "end", { outcome: "converted" }),
      ],
      edges: [
        { id: "e1", source: "mapa", target: "tarefa", condition: { type: "always" } },
        { id: "e2", source: "tarefa", target: "fim", condition: { type: "always" } },
      ],
    };
    await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
    await pool.query(
      "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
      [flow, GOV_ORG, version, `Recuperar ${original}`],
    );
    await pool.query(
      `insert into followup_enrollments
       (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
       values($1,$2,$3,$4,$5,$6,$7,'mapa','active',now()-interval '1 second',now()+interval '2 minutes')`,
      [original, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
    );
    await rodarAteParar(original);
    const morta = (await pool.query("select status,current_node_id from followup_enrollments where id=$1", [original])).rows[0];
    expect(morta).toEqual({ status: "dead", current_node_id: "tarefa" });

    // Corrige o que causou a falha e recupera (o que `reiniciarExecucao({ modo: "retry" })` grava).
    await pool.query("update crm_leads set owner_user_id=$2, owner_kind='user' where id=$1", [lead, GOV_AGENT_A]);
    await pool.query(
      `insert into followup_enrollments
       (id,organization_id,pointer_id,version_id,contact_id,lead_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until,source_enrollment_id,recovery_kind)
       values($1,$2,$3,$4,$5,$6,$7,$8,'tarefa','active',now()-interval '1 second',now()+interval '2 minutes',$9,'retry')`,
      [recuperacao, GOV_ORG, flow, version, contact, lead, origin.conversation_id, origin, original],
    );
    await rodarAteParar(recuperacao);

    const tarefa = (await pool.query("select title from crm_tasks where organization_id=$1 and lead_id=$2", [GOV_ORG, lead]))
      .rows as Array<{ title: string }>;
    expect(tarefa.map((t) => t.title)).toEqual(["Ligar: Retorno do orçamento"]);
    // O Mapear dados já tinha concluído na original: a recuperação não o roda de novo.
    const passosDaRecuperacao = (
      await pool.query("select node_id from followup_execution_steps where organization_id=$1 and enrollment_id=$2", [GOV_ORG, recuperacao])
    ).rows.map((r) => r.node_id as string);
    expect(passosDaRecuperacao).not.toContain("mapa");
    expect(passosDaRecuperacao).toContain("tarefa");
    // A original continua como estava.
    expect((await pool.query("select status from followup_enrollments where id=$1", [original])).rows[0].status).toBe("dead");
  });
});
