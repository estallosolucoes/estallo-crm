import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type * as ContractModule from "@/lib/followup/execution-contract";

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
  max: 12,
});
const journal = new PgExecutionJournal(pool);
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture(decision: "ai_classify" | "action", graceMs = 900_000) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const cfg =
    decision === "ai_classify"
      ? { classes: ["quente", "frio"], grace_timeout_ms: graceMs, target: "last_reply" }
      : { mode: "text", body: "Olá" };
  const edges =
    decision === "ai_classify"
      ? [
          {
            id: "hot",
            source: "task",
            target: "end",
            priority: 5,
            condition: { type: "class_match", value: "quente" },
          },
          {
            id: "nr",
            source: "task",
            target: "end",
            priority: 5,
            condition: { type: "class_match", value: "no_reply" },
          },
        ]
      : [{ id: "next", source: "task", target: "end", condition: { type: "always" } }];
  const graph = {
    execution_contract: 1,
    nodes: [
      { id: "task", type: decision, label: "N", position: { x: 0, y: 0 }, config: cfg },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
    ],
    edges,
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, GOV_ORG, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Borda ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,1,'task','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const input = { contact_id: contact, source: "synthetic", purpose: "classify" };
  const begin = async (): Promise<ExecutionAttemptHandle> => {
    const r = await journal.begin(await scope(), input);
    if (r.kind !== "ready") throw new Error("expected_ready");
    return r.handle;
  };
  const novoLease = () =>
    pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  const mkJob = async (worker = "w-ok", outraOrg = false) => {
    const id = randomUUID();
    let owner = contact;
    if (outraOrg) {
      owner = randomUUID();
      await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Bia','Bia')", [owner, GOV_ORG]);
    }
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload,status,locked_by,locked_at) values($1,$2,$3,'followup_turn',$4,'running',$5,date_trunc('milliseconds',now()))",
      [id, GOV_ORG, owner, { followup_enrollment_id: run, node_id: "task", source_step_key: "task:0" }, worker],
    );
    if (!outraOrg)
      await pool.query(
        "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key) values($1,$2,'task','turn_enqueued','{}','task:0') on conflict do nothing",
        [GOV_ORG, run],
      );
    const { rows } = await pool.query("select locked_at from job_queue where organization_id=$1 and id=$2", [GOV_ORG, id]);
    return { id, claim: { worker_id: worker, acquired_at: (rows[0].locked_at as Date).toISOString() } };
  };
  return { contact, run, scope, input, begin, novoLease, mkJob };
}

const quando = () => new Date(Date.now() + 3600_000);
const RODADAS = 10;
async function preparado() {
  const f = await fixture("action");
  const h = await f.begin();
  const job = await f.mkJob();
  await journal.attachJob(await f.scope(), h, job.id);
  return { f, job };
}
const eventos = async (run: string) =>
  (await pool.query("select idempotency_key from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='action_deferred'", [GOV_ORG, run])).rows;
const steps = async (run: string) =>
  Number((await pool.query("select steps_taken from followup_enrollments where organization_id=$1 and id=$2", [GOV_ORG, run])).rows[0].steps_taken);
const stale = (e: unknown) => /service_boundary_stale/.test(String(e));
const pt409 = (e: unknown) => /followup_job_stale|PT409/.test(String((e as { code?: string })?.code ?? "") + String(e));

describe("deferSend com jobClaim REAL", () => {
  it("claim valido, perdido e do job errado: so o valido adia (1 evento); os invalidos nunca criam evento", async () => {
    for (let i = 0; i < RODADAS; i++) {
      const { f, job } = await preparado();
      const outro = await f.mkJob("w-outro", true);
      const t = quando();
      const claims = {
        valido: job.claim,
        workerErrado: { ...job.claim, worker_id: "w-intruso" },
        acquiredErrado: { ...job.claim, acquired_at: new Date(Date.now() - 86_400_000).toISOString() },
        doJobErrado: outro.claim,
      } as const;
      const nomes = Object.keys(claims) as (keyof typeof claims)[];
      const r = await Promise.allSettled(
        nomes.map(async (n) => journal.deferSend(await f.scope(), job.id, t, t, "janela", claims[n])),
      );
      const out: Record<string, string> = {};
      r.forEach((x, k) => {
        const n = nomes[k]!;
        out[n] = x.status === "fulfilled" ? "ok:reused=" + x.value.reused : stale(x.reason) ? "stale" : pt409(x.reason) ? "PT409" : "outro:" + String(x.reason).slice(0, 80);
        if (x.status === "rejected") expect(String(x.reason)).not.toMatch(/23505|duplicate key/);
      });
      for (const n of ["workerErrado", "acquiredErrado", "doJobErrado"] as const)
        expect(out[n], JSON.stringify(out)).not.toBe("ok:reused=false");
      const ev = await eventos(f.run);
      expect(ev.length, JSON.stringify(out)).toBeLessThanOrEqual(1);
      expect(await steps(f.run)).toBe(0);
      process.stderr.write("[claim] " + JSON.stringify(out) + " ev=" + ev.length + "\n");
    }
  });

  it("claim invalido ISOLADO (sem corrida) e job que deixou de ser running: PT409 e 0 evento", async () => {
    const { f, job } = await preparado();
    const t = quando();
    for (const c of [{ ...job.claim, worker_id: "w-intruso" }, { ...job.claim, acquired_at: "2020-01-01T00:00:00.000Z" }]) {
      const e = await journal.deferSend(await f.scope(), job.id, t, t, "janela", c).then(() => null, (x) => x);
      expect(pt409(e), String(e)).toBe(true);
    }
    expect((await eventos(f.run)).length).toBe(0);
    await pool.query("update job_queue set status='pending' where organization_id=$1 and id=$2", [GOV_ORG, job.id]);
    const e2 = await journal.deferSend(await f.scope(), job.id, t, t, "janela", job.claim).then(() => null, (x) => x);
    expect(pt409(e2), String(e2)).toBe(true);
    expect((await eventos(f.run)).length).toBe(0);
    expect(await steps(f.run)).toBe(0);
  });

  it("NIT medido: depois de adiado, o mesmo job com claim INVALIDO e tratado sem criar 2o evento", async () => {
    const { f, job } = await preparado();
    const t = quando();
    expect((await journal.deferSend(await f.scope(), job.id, t, t, "janela", job.claim)).reused).toBe(false);
    const r = await journal.deferSend(await f.scope(), job.id, t, t, "janela", { ...job.claim, worker_id: "w-intruso" }).then((v) => "ok:reused=" + v.reused, (x) => (pt409(x) ? "PT409" : "outro:" + String(x).slice(0, 80)));
    process.stderr.write("[nit] claim invalido apos adiado => " + r + "\n");
    expect((await eventos(f.run)).length).toBe(1);
    expect(r).toMatch(/^(ok:reused=true|PT409)$/);
  });
});
