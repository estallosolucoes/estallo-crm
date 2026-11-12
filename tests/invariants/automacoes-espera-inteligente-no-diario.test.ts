import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { MAX_PLAN_RECHECKS } from "@/lib/followup/node-handlers";
import type * as ContractModule from "@/lib/followup/execution-contract";

// Libera somente a indisponibilidade para exercitar a integração em banco.
// A capacidade do produto permanece false e divergências continuam recusadas.
vi.mock("@/lib/followup/execution-contract", async (original) => {
  const m = await original<typeof ContractModule>();
  return {
    ...m,
    executionContractProblem: (...a: Parameters<typeof m.executionContractProblem>) => {
      const p = m.executionContractProblem(...a);
      return p === "execution_contract_unavailable" ? null : p;
    },
  };
});

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 6,
});
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const MIN = 600_000;
const MAX = 1_800_000;

async function fixture() {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const graph = {
    execution_contract: 1,
    nodes: [
      { id: "start", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
      {
        id: "w",
        type: "wait",
        label: "Espera",
        position: { x: 0, y: 50 },
        config: { mode: "smart", min_ms: MIN, max_ms: MAX },
      },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "w", condition: { type: "always" } },
      { id: "e2", source: "w", target: "end", condition: { type: "always" } },
    ],
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, GOV_ORG, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Espera ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,1,'start','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const jobs: string[] = [];
  const deps = {
    db: adapter,
    clock: () => new Date(),
    enqueueJob: async (job: { organization_id: string; contact_id: string; payload: object }) => {
      const id = randomUUID();
      await pool.query(
        "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
        [id, job.organization_id, job.contact_id, job.payload],
      );
      jobs.push(id);
      return { job_id: id };
    },
  };
  const tick = async () => avancarEnrollmentAtivo(deps, await scope());
  const vence = () =>
    pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  const claimDo = async (jobId: string) => {
    const locked = await pool.query(
      "update job_queue set status='running',locked_by='w-test',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
      [GOV_ORG, jobId],
    );
    return { worker_id: "w-test", acquired_at: locked.rows[0].locked_at as string };
  };
  const planeja = async (jobId: string, aguardar_ms: number) =>
    completeTurnForEnrollment(
      adapter,
      GOV_ORG,
      run,
      "start",
      { kind: "planned", propostas: [{ node_id: "w", aguardar_ms, motivo: "teste" }], modelo: "m" },
      undefined,
      jobId,
      await claimDo(jobId),
    );
  const attempts = async (node: string) =>
    (
      await pool.query(
        `select a.id,a.status,a.output_snapshot,a.next_eval_at,s.status step_status,s.branch_id
         from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id=$3 order by a.attempt_no`,
        [GOV_ORG, run, node],
      )
    ).rows;
  return { run, contact, scope, tick, vence, planeja, attempts, jobs };
}

describe("espera inteligente no diário do contrato 1", () => {
  it("o acionamento enfileira o planejamento uma vez; o plano grava, conclui o gatilho e avança na mesma transação", async () => {
    const f = await fixture();
    await f.tick();
    expect(f.jobs).toHaveLength(1);
    expect(await f.scope()).toMatchObject({ current_node_id: "start", timing_plan: null });
    expect(await f.attempts("start")).toMatchObject([{ status: "running" }]);

    await f.planeja(f.jobs[0]!, 900_000);
    const s = await f.scope();
    expect(s).toMatchObject({ current_node_id: "w", steps_taken: 2, status: "active" });
    expect(s.timing_plan).toMatchObject({ modelo: "m", esperas: { w: { escolhido_ms: 900_000 } } });
    expect(await f.attempts("start")).toMatchObject([
      {
        status: "succeeded",
        step_status: "succeeded",
        branch_id: "else",
        output_snapshot: { contact_id: f.contact, lead_id: null },
      },
    ]);
    const ev = await pool.query(
      "select count(*)::int n from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='timing_plan_decidido'",
      [GOV_ORG, f.run],
    );
    expect(ev.rows[0].n).toBe(1);

    // O mesmo job concluindo de novo (retry depois do commit) não regrava nada.
    await f.planeja(f.jobs[0]!, 1_200_000);
    expect((await f.scope()).timing_plan).toMatchObject({
      esperas: { w: { escolhido_ms: 900_000 } },
    });
    expect(await f.attempts("start")).toHaveLength(1);
  });

  it("a espera smart usa o plano (clampado pelo nó) e conclui com mode=smart no prazo", async () => {
    const f = await fixture();
    await f.tick();
    await f.planeja(f.jobs[0]!, 5_000_000_000); // proposta fora do intervalo: o nó decide
    expect((await f.scope()).timing_plan).toMatchObject({
      esperas: { w: { escolhido_ms: MAX, clampado: true } },
    });
    const antes = Date.now();
    await f.tick();
    const [parked] = await f.attempts("w");
    expect(parked).toMatchObject({ status: "waiting" });
    const prazo = new Date(parked.next_eval_at).getTime();
    expect(prazo - antes).toBeGreaterThanOrEqual(MAX - 5_000);
    expect(prazo - antes).toBeLessThanOrEqual(MAX + 5_000);

    await pool.query(
      "update followup_execution_attempts set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
      [GOV_ORG, parked.id],
    );
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 4 });
    expect((await f.attempts("w"))[0]).toMatchObject({
      status: "succeeded",
      output_snapshot: { mode: "smart" },
    });
  });

  it("enquanto o plano não volta, os rechecks não abrem tentativa nova nem reenfileiram", async () => {
    const f = await fixture();
    await f.tick();
    for (let i = 0; i < MAX_PLAN_RECHECKS - 1; i++) {
      await f.vence();
      await f.tick();
    }
    expect(f.jobs).toHaveLength(1);
    expect(await f.attempts("start")).toMatchObject([{ status: "running" }]);
    expect(await f.scope()).toMatchObject({ current_node_id: "start" });
  });

  it("o plano nunca voltou (plan_timeout): segue sem plano pelo diário, e o turno tardio vira no-op", async () => {
    const f = await fixture();
    await f.tick();
    for (
      let i = 0;
      i < MAX_PLAN_RECHECKS + 2 && (await f.scope()).current_node_id === "start";
      i++
    ) {
      await f.vence();
      await f.tick();
    }
    const s = await f.scope();
    expect(s).toMatchObject({ current_node_id: "w", timing_plan: null });
    const start = await f.attempts("start");
    expect(start.filter((a) => a.status === "succeeded")).toHaveLength(1);
    expect(start.find((a) => a.status === "succeeded")).toMatchObject({ branch_id: "else" });

    await f.planeja(f.jobs[0]!, 900_000); // o turno chega depois: nada muda
    expect(await f.scope()).toMatchObject({ current_node_id: "w", timing_plan: null });
  });
});
