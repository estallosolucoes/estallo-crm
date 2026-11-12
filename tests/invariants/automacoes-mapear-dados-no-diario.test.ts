import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_AGENT_A, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Mapear dados (Fase 4) no motor novo, com Postgres real: o bloco lê a saída de um bloco ANTERIOR desta execução
 * (gravada no diário), monta os campos e grava a própria saída; campo sem valor e sem padrão FALHA com explicação.
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
    throw new Error("mapear_dados_must_not_enqueue");
  },
};

const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

const grafo = (campos: object[]) => ({
  execution_contract: 1,
  nodes: [
    no("cond", "condition", {
      combinator: "and",
      branching: "per_check",
      checks: [{ id: "tem_vip", label: "VIP", field: "tag", op: "contains", value: "vip" }],
    }),
    no("mapa", "map_data", { fields: campos }),
    no("fim", "end", { outcome: "converted" }),
  ],
  edges: [
    { id: "e1", source: "cond", target: "mapa", condition: { type: "branch", branch_id: "tem_vip" } },
    { id: "e2", source: "cond", target: "mapa", condition: { type: "always" } },
    { id: "e3", source: "mapa", target: "fim", condition: { type: "always" } },
  ],
});

async function rodar(campos: object[]) {
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
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, grafo(campos)]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Mapa ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'cond','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  for (let i = 0; i < 4; i++) {
    const scope = await adapter.loadEnrollmentById(GOV_ORG, run);
    if (!scope || scope.status !== "active" || scope.current_node_id === "fim") break;
    expect(scope.execution_contract).toBe(1);
    await avancarEnrollmentAtivo(deps, scope);
    // o próximo bloco pode ter ficado para o tick seguinte: devolve a inscrição ao relógio
    await pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1 and status='active'",
      [run],
    );
  }
  const passo = (
    await pool.query(
      `select s.status, a.output_snapshot, a.error_snapshot
         from followup_execution_steps s
         join followup_execution_attempts a on a.step_id = s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='mapa'
        order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0] as { status: string; output_snapshot: unknown; error_snapshot: { message?: string } | null } | undefined;
  const inscricao = (
    await pool.query("select current_node_id,status from followup_enrollments where id=$1", [run])
  ).rows[0] as { current_node_id: string; status: string };
  return { passo, inscricao };
}

describe("Mapear dados no diário (motor novo, Postgres real)", () => {
  it("lê a saída da condição anterior, converte e grava os campos como saída do bloco", async () => {
    const { passo, inscricao } = await rodar([
      { name: "saida", value: "{{nodes.cond.branch_id}}", type: "text" },
      { name: "casou", value: "{{nodes.cond.matched}}", type: "boolean" },
      { name: "frase", value: "Caminho: {{nodes.cond.branch_id}}", type: "text" },
    ]);
    expect(passo?.status).toBe("succeeded");
    expect(passo?.output_snapshot).toEqual({ fields: { saida: "else", casou: false, frase: "Caminho: else" } });
    expect(inscricao.current_node_id).toBe("fim");
  });

  it("campo que cita valor inexistente, sem padrão, falha com a explicação — nunca segue com vazio", async () => {
    const { passo, inscricao } = await rodar([{ name: "codigo", value: "{{nodes.cond.nao_existe}}", type: "text" }]);
    expect(passo?.status).toBe("failed");
    expect(passo?.error_snapshot?.message).toContain("codigo");
    expect(inscricao.current_node_id).toBe("mapa");
  });

  it("com valor padrão configurado, o ausente usa o padrão convertido", async () => {
    const { passo } = await rodar([{ name: "n", value: "{{nodes.cond.nao_existe}}", type: "number", fallback: "0" }]);
    expect(passo?.output_snapshot).toEqual({ fields: { n: 0 } });
  });
});

describe("a saída do Mapear dados alimenta o título da Criar tarefa (aceite da Fase 4)", () => {
  it("o título resolve {{nodes.mapa.fields.*}} com o valor montado", async () => {
    const contact = randomUUID(),
      version = randomUUID(),
      flow = randomUUID(),
      run = randomUUID(),
      lead = randomUUID(),
      pipeline = randomUUID(),
      stage = randomUUID(),
      slug = randomUUID().slice(0, 8);
    // Atendente (não viewer): o gatilho 0403 recusa viewer como responsável do negócio.
    const dono = { user_id: GOV_AGENT_A };
    await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
    await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Vendas',$3)", [pipeline, GOV_ORG, `v-${slug}`]);
    await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo',$4,1000)", [stage, GOV_ORG, pipeline, `n-${slug}`]);
    await pool.query(
      "insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,position_in_stage,owner_user_id) values($1,$2,$3,$4,$5,'Negócio',500,$6)",
      [lead, GOV_ORG, contact, pipeline, stage, dono.user_id],
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
      [flow, GOV_ORG, version, `Mapa tarefa ${run}`],
    );
    await pool.query(
      `insert into followup_enrollments
       (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
       values($1,$2,$3,$4,$5,$6,$7,'mapa','active',now()-interval '1 second',now()+interval '2 minutes')`,
      [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
    );
    for (let i = 0; i < 4; i++) {
      const scope = await adapter.loadEnrollmentById(GOV_ORG, run);
      if (!scope || scope.status !== "active" || scope.current_node_id === "fim") break;
      await avancarEnrollmentAtivo(deps, scope);
      await pool.query(
        "update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1 and status='active'",
        [run],
      );
    }
    const tarefa = (await pool.query("select title from crm_tasks where organization_id=$1 and lead_id=$2", [GOV_ORG, lead]))
      .rows[0] as { title: string } | undefined;
    expect(tarefa?.title).toBe("Ligar: Retorno do orçamento");
  });
});
