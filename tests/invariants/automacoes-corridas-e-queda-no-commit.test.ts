import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { pgSendLedger, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import type * as ContractModule from "@/lib/followup/execution-contract";

// Libera somente a indisponibilidade para exercitar a integração em banco.
// A capacidade do produto permanece false e divergências continuam recusadas.
vi.mock("@/lib/followup/execution-contract", async (original) => {
  const contractModule = await original<typeof ContractModule>();
  return {
    ...contractModule,
    executionContractProblem: (
      ...args: Parameters<typeof contractModule.executionContractProblem>
    ) => {
      const problem = contractModule.executionContractProblem(...args);
      return problem === "execution_contract_unavailable" ? null : problem;
    },
  };
});

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 4,
});
// kill -9 de backend derruba as conexões ociosas: sem isto o pool vira erro não tratado
pool.on("error", () => {});
// igual a lib/agent-engine/db/pool.ts (createPool): sem listener por-cliente a queda vira uncaughtException
pool.on("connect", (c) => c.on("error", () => {}));
const journal = new PgExecutionJournal(pool);
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture(
  options: {
    owner?: string | null;
    contract?: 0 | 1;
    decision?:
      "action" | "condition" | "trigger" | "edit_lead_tag" | "move_lead" | "wait" | "repeat";
    immune?: boolean;
    withoutLead?: boolean;
    settings?: unknown;
    target?: "open" | "won" | "lost";
    closed?: "won" | "lost";
    lostReason?: string;
    wonReason?: string;
    targetStageId?: string;
  } = {},
) {
  const contact = randomUUID(),
    lead = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  const pipeline = options.decision === "move_lead" ? randomUUID() : GOV_PIPELINE;
  const sourceStage = options.decision === "move_lead" ? randomUUID() : GOV_STAGE;
  const destination = randomUUID();
  if (options.decision === "move_lead") {
    await pool.query(
      "insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,$3,$3,$4)",
      [
        pipeline,
        GOV_ORG,
        `j-${run}`,
        typeof options.settings === "function"
          ? options.settings(destination)
          : (options.settings ?? {}),
      ],
    );
    await pool.query(
      `insert into crm_stages(id,organization_id,pipeline_id,name,slug,position,is_lost,is_won) values
      ($1,$3,$4,'Origem','origem',1000,$5,$6),($2,$3,$4,'Destino','destino',2000,$7,$8)`,
      [
        sourceStage,
        destination,
        GOV_ORG,
        pipeline,
        options.closed === "lost",
        options.closed === "won",
        options.target === "lost",
        options.target === "won",
      ],
    );
  }
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana Souza','Ana')",
    [contact, GOV_ORG],
  );
  await pool.query(
    `insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,owner_user_id,lost_reason)
    values($1,$2,$3,$4,$5,'Contrato original',$6,$7)`,
    [
      lead,
      GOV_ORG,
      contact,
      pipeline,
      sourceStage,
      options.owner === undefined ? GOV_MANAGER : options.owner,
      options.closed === "lost" ? "other" : null,
    ],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const graph = {
    execution_contract: 1,
    nodes: [
      {
        id: "task",
        type: "internal_task",
        label: "Lembrar responsável",
        position: { x: 0, y: 0 },
        config: {
          titulo: "Ligar para {{contact.name}} sobre {{lead.title}}",
          vence_em_dias: 1,
          atribuir_a: "dono_do_lead",
          prioridade: "high",
        },
      },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
    ],
    edges: [{ id: "next", source: "task", target: "end", condition: { type: "always" } }],
  };
  if (options.decision) {
    const variant = {
      ...graph,
      nodes: [
        {
          id: "task",
          type: options.decision,
          label: "Decisão",
          position: { x: 0, y: 0 },
          config:
            options.decision === "condition"
              ? { combinator: "and", checks: [{ field: "tag", op: "contains", value: "vip" }] }
              : options.decision === "edit_lead_tag"
                ? { tags: ["vip"] }
                : options.decision === "move_lead"
                  ? {
                      stage_id: options.targetStageId ?? destination,
                      ...(options.lostReason ? { lost_reason: options.lostReason } : {}),
                      ...(options.wonReason ? { won_reason: options.wonReason } : {}),
                    }
                  : options.decision === "wait"
                    ? {
                        mode: "fixed",
                        duration_ms: 300000,
                        immune_to_reply: options.immune ?? false,
                      }
                    : options.decision === "repeat"
                      ? { max_count: 3 }
                      : options.decision === "action"
                        ? { mode: "text", body: "Olá" }
                        : {},
        },
        graph.nodes[1],
      ],
      edges:
        options.decision === "condition"
          ? [
              {
                id: "true-edge",
                source: "task",
                target: "end",
                condition: { type: "cond_result", value: true },
              },
              {
                id: "false-edge",
                source: "task",
                target: "end",
                condition: { type: "cond_result", value: false },
              },
            ]
          : options.decision === "repeat"
            ? [
                {
                  id: "body",
                  source: "task",
                  target: "task",
                  condition: { type: "branch", branch_id: "body" },
                },
                {
                  id: "done",
                  source: "task",
                  target: "end",
                  condition: { type: "branch", branch_id: "done" },
                },
                { id: "escape", source: "task", target: "end", condition: { type: "always" } },
              ]
            : graph.edges,
    };
    await pool.query(
      "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
      [version, GOV_ORG, variant],
    );
  } else {
    await pool.query(
      "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
      [version, GOV_ORG, graph],
    );
  }
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Diário sintético ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
    (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,lead_id,execution_contract,current_node_id,status,next_eval_at,claimed_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'task','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [
      run,
      GOV_ORG,
      flow,
      version,
      contact,
      origin.conversation_id,
      origin,
      options.withoutLead ? null : lead,
      options.contract ?? 1,
    ],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const begin = async (enrollment?: EnrollmentRow): Promise<ExecutionAttemptHandle> => {
    const result = await journal.begin(enrollment ?? (await scope()), {
      contact_id: contact,
      lead_id: lead,
      source: "synthetic",
    });
    if (result.kind !== "ready") throw new Error("expected_ready");
    return result.handle;
  };
  const counts = async () =>
    (
      await pool.query<{ tasks: number; effects: number; activities: number }>(
        `select
    (select count(*)::int from crm_tasks where organization_id=$1 and contact_id=$2) tasks,
    (select count(*)::int from followup_execution_effects where organization_id=$1 and enrollment_id=$3) effects,
    (select count(*)::int from crm_lead_activities where organization_id=$1 and lead_id=$4 and type='task_created') activities`,
        [GOV_ORG, contact, run, lead],
      )
    ).rows[0]!;
  return {
    contact,
    lead,
    run,
    version,
    scope,
    begin,
    counts,
    pipeline,
    sourceStage,
    destination: options.targetStageId ?? destination,
  };
}

// ---------------------------------------------------------------------------
// Ajudantes
// ---------------------------------------------------------------------------
const own = (run: string, steps = 0) => ({
  followup_enrollment_id: run,
  node_id: "task",
  source_step_key: `task:${steps}`,
});
const mkJob = async (contact: string, payload: Record<string, unknown>) => {
  const id = randomUUID();
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
    [id, GOV_ORG, contact, payload],
  );
  return id;
};
const linked = async (attempt: string) =>
  (
    await pool.query(
      "select job_id from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, attempt],
    )
  ).rows[0].job_id as string | null;
const attemptStatus = async (attempt: string) =>
  (
    await pool.query(
      "select status from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, attempt],
    )
  ).rows[0].status as string;
const events = async (run: string, type: string) =>
  (
    await pool.query(
      "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type=$2",
      [run, type],
    )
  ).rows[0].n as number;
const pending = async (p: Promise<unknown>, ms = 600) =>
  (await Promise.race([
    p.then(
      () => false,
      () => false,
    ),
    new Promise((r) => setTimeout(() => r(true), ms)),
  ])) as boolean;

// Envio enfileirado pelo motor: tentativa aberta + job ligado + job "running" com claim.
async function envioEnfileirado() {
  const f = await fixture({ decision: "action" });
  let jobId = "";
  await avancarEnrollmentAtivo(
    {
      db: adapter,
      clock: () => new Date(),
      enqueueJob: async (job: { organization_id: string; contact_id: string; payload: object }) => {
        jobId = randomUUID();
        await pool.query(
          "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
          [jobId, job.organization_id, job.contact_id, job.payload],
        );
        return { job_id: jobId };
      },
    },
    await f.scope(),
  );
  const locked = await pool.query(
    "update job_queue set status='running',locked_by='w-test',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
    [GOV_ORG, jobId],
  );
  const claim = { worker_id: "w-test", acquired_at: locked.rows[0].locked_at as string };
  const accept = async () => {
    const message = randomUUID();
    await pool.query(
      `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values($1,$2,$3,1,'hash','accepted',$4)`,
      [GOV_ORG, f.contact, jobId, message],
    );
    return message;
  };
  return { f, jobId, claim, accept };
}
const sendCounts = async (run: string) =>
  (
    await pool.query<{ effects: number; succeeded: number }>(
      `select (select count(*)::int from followup_execution_effects where organization_id=$1 and enrollment_id=$2) effects,
              (select count(*)::int from followup_execution_attempts a join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
                where s.organization_id=$1 and s.enrollment_id=$2 and a.status='succeeded') succeeded`,
      [GOV_ORG, run],
    )
  ).rows[0]!;
const jobAttemptId = async (jobId: string) =>
  (
    await pool.query(
      "select id from followup_execution_attempts where organization_id=$1 and job_id=$2",
      [GOV_ORG, jobId],
    )
  ).rows[0].id as string;

// ---------------------------------------------------------------------------
// (a) attachJob x parkWait
// ---------------------------------------------------------------------------
describe("(a) attachJob × parkWait", () => {
  const park = (when = 300000) => ({
    kind: "wait" as const,
    next_eval_at: new Date(Date.now() + when),
  });

  it("corrida (8x): parkWait sempre conclui; attachJob liga o job pedido OU recusa por estado velho — nunca meio-gravado", async () => {
    for (let i = 0; i < 8; i++) {
      const f = await fixture({ decision: "wait" });
      const handle = await f.begin();
      const scope = await f.scope();
      const job = await mkJob(f.contact, own(f.run));
      const [attach, parked] = await Promise.allSettled([
        journal.attachJob(scope, handle, job),
        journal.parkWait(scope, handle, park()),
      ]);
      expect(parked.status).toBe("fulfilled");
      if (attach.status === "rejected") {
        expect(attach.reason).toBeInstanceOf(StaleServiceBoundaryError);
        expect(await linked(handle.attempt_id)).toBeNull();
      } else {
        expect(await linked(handle.attempt_id)).toBe(job);
      }
      expect(await attemptStatus(handle.attempt_id)).toBe("waiting");
      expect(await events(f.run, "wait_started")).toBe(1);
      expect(await f.scope()).toMatchObject({ steps_taken: 1 });
    }
  });

  it("attach ANTES do estacionamento: os dois passam e o vínculo sobrevive ao parkWait", async () => {
    const f = await fixture({ decision: "wait" });
    const handle = await f.begin();
    const scope = await f.scope();
    const job = await mkJob(f.contact, own(f.run));
    await journal.attachJob(scope, handle, job);
    await journal.parkWait(scope, handle, park());
    expect(await linked(handle.attempt_id)).toBe(job);
    expect(await attemptStatus(handle.attempt_id)).toBe("waiting");
  });

  it("serialização: com o attachJob parado no job_queue, o parkWait NÃO conclui antes dele", async () => {
    const f = await fixture({ decision: "wait" });
    const handle = await f.begin();
    const scope = await f.scope();
    const job = await mkJob(f.contact, own(f.run));
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from job_queue where id=$1 for update", [job]);
      const attach = journal.attachJob(scope, handle, job);
      await new Promise((r) => setTimeout(r, 300));
      const parked = journal.parkWait(scope, handle, park());
      expect(await pending(parked)).toBe(true); // bloqueado atrás do attach
      expect(await attemptStatus(handle.attempt_id)).toBe("running");
      await blocker.query("rollback");
      await expect(attach).resolves.toEqual({ reused: false });
      await expect(parked).resolves.toEqual({ reused: false });
    } finally {
      blocker.release();
    }
    expect(await linked(handle.attempt_id)).toBe(job);
    expect(await attemptStatus(handle.attempt_id)).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// (b) attachJob x completeTask
// ---------------------------------------------------------------------------
describe("(b) attachJob × completeTask", () => {
  it("corrida (8x): uma tarefa, um efeito, passagem concluída; attach liga OU recusa por estado velho", async () => {
    for (let i = 0; i < 8; i++) {
      const f = await fixture();
      const handle = await f.begin();
      const scope = await f.scope();
      const job = await mkJob(f.contact, own(f.run));
      const [attach, done] = await Promise.allSettled([
        journal.attachJob(scope, handle, job),
        journal.completeTask(scope, handle),
      ]);
      expect(done.status).toBe("fulfilled");
      if (attach.status === "rejected") {
        expect(attach.reason).toBeInstanceOf(StaleServiceBoundaryError);
        expect(await linked(handle.attempt_id)).toBeNull();
      } else {
        expect(await linked(handle.attempt_id)).toBe(job);
      }
      expect(await f.counts()).toEqual({ tasks: 1, effects: 1, activities: 1 });
      expect(await attemptStatus(handle.attempt_id)).toBe("succeeded");
      expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    }
  });

  it("attach DEPOIS da conclusão (escopo novo, mesmo handle): recusado e job_id continua nulo", async () => {
    const f = await fixture();
    const handle = await f.begin();
    const job = await mkJob(f.contact, own(f.run));
    await journal.completeTask(await f.scope(), handle);
    await expect(journal.attachJob(await f.scope(), handle, job)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(await linked(handle.attempt_id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) queda de conexão / SIGKILL durante o COMMIT do completeSend
// ---------------------------------------------------------------------------
type Hook = (
  text: string,
  client: pg.PoolClient,
  run: () => Promise<unknown>,
) => Promise<unknown> | undefined;
/** Pool que devolve o MESMO cliente real, com a consulta "commit" interceptável. */
function poolComGancho(real: pg.Pool, hook: Hook): pg.Pool {
  return {
    connect: async () => {
      const client = await real.connect();
      const original = client.query;
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      const release = client.release.bind(client);
      // devolve o cliente limpo ao pool: o gancho não pode vazar para o teste seguinte
      client.release = (err?: boolean | Error) => {
        (client as unknown as { query: unknown }).query = original;
        client.release = release;
        release(err);
      };
      (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
        const text = typeof a[0] === "string" ? a[0] : "";
        return hook(text, client, () => query(...a)) ?? query(...a);
      };
      return client;
    },
  } as unknown as pg.Pool;
}
const semConcluir = async (f: { run: string; scope: () => Promise<EnrollmentRow> }) => {
  expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
  expect(await sendCounts(f.run)).toEqual({ effects: 0, succeeded: 0 });
};

describe("(c) queda no COMMIT do completeSend", () => {
  it("conexão some ANTES de o COMMIT chegar ao servidor: nada gravado; repetir conclui UMA vez", async () => {
    const { f, jobId, claim, accept } = await envioEnfileirado();
    const message = await accept();
    const quebrado = new PgExecutionJournal(
      poolComGancho(pool, (text, client) => {
        if (text !== "commit") return undefined;
        (
          client as unknown as { connection: { stream: { destroy(): void } } }
        ).connection.stream.destroy();
        return Promise.reject(new Error("Connection terminated (simulada antes do COMMIT)"));
      }),
    );
    await expect(quebrado.completeSend(await f.scope(), jobId, claim)).rejects.toThrow(
      /Connection terminated/,
    );
    await semConcluir(f);
    expect(await attemptStatus(await jobAttemptId(jobId))).toBe("running");
    // reentrega do job: conclui, com o recibo ORIGINAL do ledger
    const out = await journal.completeSend(await f.scope(), jobId, claim);
    expect(out).toMatchObject({ reused: false, output: { messages: [{ message_id: message }] } });
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    expect(await events(f.run, "action_sent")).toBe(1);
  });

  it("COMMIT chega ao servidor mas o ACK se perde: efeito já gravado; repetir devolve reused e não duplica", async () => {
    const { f, jobId, claim, accept } = await envioEnfileirado();
    await accept();
    const quebrado = new PgExecutionJournal(
      poolComGancho(pool, (text, _c, run) =>
        text === "commit" ? run().then(() => Promise.reject(new Error("ACK perdido"))) : undefined,
      ),
    );
    await expect(quebrado.completeSend(await f.scope(), jobId, claim)).rejects.toThrow(
      /ACK perdido/,
    );
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 2 });
    // 1) direto no diário
    await expect(journal.completeSend(await f.scope(), jobId, claim)).resolves.toMatchObject({
      reused: true,
    });
    // 2) pela ponte: o enrollment já saiu do nó => no-op silencioso, sem lançar
    await expect(
      completeTurnForEnrollment(
        adapter,
        GOV_ORG,
        f.run,
        "task",
        { kind: "sent" },
        undefined,
        jobId,
        claim,
      ),
    ).resolves.toBeUndefined();
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    expect(await events(f.run, "action_sent")).toBe(1);
  });

  describe("backend morto DURANTE o COMMIT (trigger deferido segura o COMMIT por 3s)", () => {
    const container = process.env.TEST_DB_CONTAINER!;
    async function prepararTrigger() {
      await pool.query(`
        create or replace function public.t_segura_commit() returns trigger language plpgsql as
        $$ begin perform pg_sleep(3); return null; end $$;
        drop trigger if exists t_segura_commit on followup_execution_effects;
        create constraint trigger t_segura_commit after insert on followup_execution_effects
          deferrable initially deferred for each row execute function public.t_segura_commit();`);
    }
    const soltarTrigger = (p: pg.Pool) =>
      p.query("drop trigger if exists t_segura_commit on followup_execution_effects");
    /** Espera o backend que está executando literalmente "commit" e devolve o pid. */
    async function pidNoCommit(): Promise<number> {
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(
          "select pid from pg_stat_activity where datname=current_database() and state='active' and query='commit' and pid<>pg_backend_pid()",
        );
        if (rows[0]) return rows[0].pid;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("COMMIT nunca ficou visível em pg_stat_activity");
    }

    it("pg_terminate_backend no COMMIT: erro ao chamador, nada gravado, repetir conclui UMA vez", async () => {
      const { f, jobId, claim, accept } = await envioEnfileirado();
      const message = await accept();
      await prepararTrigger();
      try {
        const settled = journal.completeSend(await f.scope(), jobId, claim).then(
          () => null,
          (e: unknown) => e,
        );
        const pid = await pidNoCommit();
        await pool.query("select pg_terminate_backend($1)", [pid]);
        expect(await settled).toBeInstanceOf(Error);
        await semConcluir(f);
      } finally {
        await soltarTrigger(pool);
      }
      const out = await journal.completeSend(await f.scope(), jobId, claim);
      expect(out).toMatchObject({ reused: false, output: { messages: [{ message_id: message }] } });
      expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    });

    // kill -9 faz o Postgres entrar em recuperação (lento com disco saturado): só com TEST_DB_KILL9=1.
    it.skipIf(!process.env.TEST_DB_KILL9)(
      "kill -9 do backend no COMMIT (o Postgres inteiro entra em recuperação): nada gravado; repetir conclui UMA vez",
      async () => {
        const { f, jobId, claim, accept } = await envioEnfileirado();
        await accept();
        await prepararTrigger();
        const settled = journal.completeSend(await f.scope(), jobId, claim).then(
          () => null,
          (e: unknown) => e,
        );
        const pid = await pidNoCommit();
        execFileSync("docker", ["exec", container, "sh", "-c", `kill -9 ${Number(pid)}`]);
        expect(await settled).toBeInstanceOf(Error);
        // o postmaster reinicia todos os backends; conexão nova só volta depois da recuperação
        const novo = new pg.Pool({
          connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
          max: 2,
        });
        novo.on("error", () => {});
        novo.on("connect", (c) => c.on("error", () => {}));
        try {
          let voltou = false;
          for (let i = 0; i < 480 && !voltou; i++) {
            try {
              await novo.query("select 1");
              voltou = true;
            } catch {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          expect(voltou).toBe(true);
          const j = new PgExecutionJournal(novo);
          const scope = (await createPgAdminClient(novo).loadEnrollmentById(GOV_ORG, f.run))!;
          expect(scope).toMatchObject({ current_node_id: "task", steps_taken: 1 });
          const antes = await novo.query(
            "select count(*)::int e from followup_execution_effects where enrollment_id=$1",
            [f.run],
          );
          expect(antes.rows[0].e).toBe(0);
          await soltarTrigger(novo);
          await expect(j.completeSend(scope, jobId, claim)).resolves.toMatchObject({
            reused: false,
          });
          const depois = await novo.query(
            "select count(*)::int e from followup_execution_effects where enrollment_id=$1",
            [f.run],
          );
          expect(depois.rows[0].e).toBe(1);
        } finally {
          await novo.end();
          // o pool principal também foi derrubado: os testes seguintes precisam dele de volta
          for (let i = 0; i < 480; i++) {
            try {
              await pool.query("select 1");
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }
      },
      400_000,
    );
  });
});

// ---------------------------------------------------------------------------
// (d) job reexecutado depois de o canal aceitar (sendWithLedger => already_sent)
// ---------------------------------------------------------------------------
describe("(d) reexecução do job após o canal aceitar", () => {
  const intent = (f: { contact: string }, jobId: string) => ({
    tenantId: GOV_ORG,
    leadId: f.contact,
    jobId,
    seq: 1,
    body: "Olá",
  });

  it("1ª execução enviou e o completeSend não rodou; 2ª: already_sent SEM chamar o canal, e a conclusão sai uma vez com o recibo da 1ª", async () => {
    const { f, jobId, claim } = await envioEnfileirado();
    const store = pgSendLedger(pool);
    const canal = vi.fn(async (_key: string, id: string) => ({ id, status: "sent" }));
    const first = await sendWithLedger(store, intent(f, jobId), canal);
    expect(first.kind).toBe("sent");
    expect(canal).toHaveBeenCalledTimes(1);
    const second = await sendWithLedger(store, intent(f, jobId), canal);
    expect(second.kind).toBe("already_sent");
    expect(canal).toHaveBeenCalledTimes(1); // nenhum segundo envio ao canal
    await semConcluir(f);
    // a ponte trata already_sent como "sent": agora conclui
    await completeTurnForEnrollment(
      adapter,
      GOV_ORG,
      f.run,
      "task",
      { kind: "sent" },
      undefined,
      jobId,
      claim,
    );
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 2 });
    const led = await pool.query(
      "select count(*)::int n, min(crm_message_id::text) m from send_ledger where job_id=$1",
      [jobId],
    );
    expect(led.rows[0].n).toBe(1);
    const eff = await pool.query(
      "select external_ref from followup_execution_effects where enrollment_id=$1",
      [f.run],
    );
    expect(eff.rows[0].external_ref).toBe(led.rows[0].m);
  });

  it("3ª execução depois de concluído: already_sent de novo, a ponte vira no-op, nada duplica", async () => {
    const { f, jobId, claim } = await envioEnfileirado();
    const store = pgSendLedger(pool);
    const canal = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
    await sendWithLedger(store, intent(f, jobId), canal);
    await completeTurnForEnrollment(
      adapter,
      GOV_ORG,
      f.run,
      "task",
      { kind: "sent" },
      undefined,
      jobId,
      claim,
    );
    const again = await sendWithLedger(store, intent(f, jobId), canal);
    expect(again.kind).toBe("already_sent");
    await completeTurnForEnrollment(
      adapter,
      GOV_ORG,
      f.run,
      "task",
      { kind: "sent" },
      undefined,
      jobId,
      claim,
    );
    expect(canal).toHaveBeenCalledTimes(1);
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    expect(await events(f.run, "action_sent")).toBe(1);
  });

  it("canal respondeu 'queued': a reexecução NÃO conclui (execution_send_receipt_missing)", async () => {
    const { f, jobId, claim } = await envioEnfileirado();
    const canal = vi.fn(async (_k: string, id: string) => ({ id, status: "queued" }));
    const out = await sendWithLedger(pgSendLedger(pool), intent(f, jobId), canal);
    expect(out.kind).toBe("queued");
    await expect(
      completeTurnForEnrollment(
        adapter,
        GOV_ORG,
        f.run,
        "task",
        { kind: "sent" },
        undefined,
        jobId,
        claim,
      ),
    ).rejects.toMatchObject({ code: "execution_send_receipt_missing" });
    await semConcluir(f);
  });
});
