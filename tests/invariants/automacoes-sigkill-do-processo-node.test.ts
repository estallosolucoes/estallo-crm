import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
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
const events = async (run: string, type: string) =>
  (
    await pool.query(
      "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type=$2",
      [run, type],
    )
  ).rows[0].n as number;

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

// ---------------------------------------------------------------------------
// (a) attachJob x parkWait
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SIGKILL de verdade do PROCESSO NODE (não do backend do Postgres) no meio do completeSend.
// O filho é um `tsx` real com a própria conexão; o pai o mata quando o servidor mostra que ele
// está (A) no meio da transação ou (B) no COMMIT. Invariante: o estado é atômico (tudo ou nada),
// nada fica preso, e a reentrega conclui UMA vez.
// ---------------------------------------------------------------------------
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

// `node --import tsx` e NAO o `tsx/dist/cli.mjs`: o cli e um wrapper que cria um processo filho, e SIGKILL no wrapper
// nao chega ao filho (que e quem tem a conexao). Em Linux o filho sobrevivia e concluia a transacao.
const TSX_IMPORT = ["--import", "tsx"];
const CHILD = path.resolve("tests/invariants/_sigkill-child-completesend.ts");
const APP = "sigkill-child";

describe("SIGKILL do processo Node durante o completeSend", () => {
  const prepararTrigger = (deferred: boolean) =>
    pool.query(`
      create or replace function public.t_segura() returns trigger language plpgsql as
      $$ begin perform pg_sleep(4); return null; end $$;
      drop trigger if exists t_segura on followup_execution_effects;
      create ${deferred ? "constraint " : ""}trigger t_segura after insert on followup_execution_effects
        ${deferred ? "deferrable initially deferred" : ""} for each row execute function public.t_segura();`);
  const soltar = () => pool.query("drop trigger if exists t_segura on followup_execution_effects");

  async function filhoNoPonto(
    ponto: "meio-da-transacao" | "commit",
    env: Record<string, string>,
  ): Promise<{ child: ChildProcess; stdout: () => string; exited: Promise<string> }> {
    const child = spawn(process.execPath, [...TSX_IMPORT, CHILD], {
      env: {
        ...process.env,
        ...env,
        PGAPPNAME: APP,
        DB_PORT: String(process.env.TEST_DB_PORT ?? 54329),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += "[err]" + d));
    const exited = new Promise<string>((res) =>
      child.on("exit", (code, sig) => res(`code=${code} signal=${sig}`)),
    );
    const quando =
      ponto === "commit" ? "query = 'commit'" : "query <> 'commit' and query ilike 'insert into%'";
    for (let i = 0; i < 600; i++) {
      const { rows } = await pool.query(
        `select 1 from pg_stat_activity where application_name=$1 and state='active'
           and wait_event = 'PgSleep' and ${quando}`,
        [APP],
      );
      if (rows[0]) return { child, stdout: () => out, exited };
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill("SIGKILL");
    throw new Error("filho nunca chegou ao ponto " + ponto + "; saída: " + out);
  }
  const semBackendDoFilho = async () => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        "select 1 from pg_stat_activity where application_name=$1",
        [APP],
      );
      if (!rows[0]) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  it.each(["meio-da-transacao", "commit"] as const)(
    "morto com SIGKILL %s: estado atômico, nada preso, reentrega conclui UMA vez",
    async (ponto) => {
      const { f, jobId, claim, accept } = await envioEnfileirado();
      const message = await accept();
      await prepararTrigger(ponto === "commit");
      let observado: { effects: number; succeeded: number };
      try {
        const { child, stdout, exited } = await filhoNoPonto(ponto, {
          ORG: GOV_ORG,
          ENROLLMENT: f.run,
          JOB: jobId,
          CLAIM_WORKER: claim.worker_id,
          CLAIM_AT: claim.acquired_at,
        });
        child.kill("SIGKILL");
        const how = await exited;
        expect(how).not.toBe("code=0 signal=null");
        expect(stdout()).not.toContain("DONE");
        // o servidor acaba descobrindo o socket morto (A: ao tentar ler depois do sleep; B: depois do commit)
        expect(await semBackendDoFilho()).toBe(true);
        observado = await sendCounts(f.run);
        // atômico: tudo ou nada
        expect([
          { effects: 0, succeeded: 0 },
          { effects: 1, succeeded: 1 },
        ]).toContainEqual(observado);
        // nenhuma transação aberta pendurada, nenhum lock do filho
        const pendurado = await pool.query(
          "select count(*)::int n from pg_stat_activity where state like 'idle in transaction%' and datname=current_database()",
        );
        expect(pendurado.rows[0].n).toBe(0);
        if (ponto === "meio-da-transacao") expect(observado).toEqual({ effects: 0, succeeded: 0 });
        if (process.env.OBS_FILE)
          (await import("node:fs")).appendFileSync(
            process.env.OBS_FILE,
            `[sigkill ${ponto}] ${how} -> ${JSON.stringify(observado)}
`,
          );
      } finally {
        await soltar();
      }
      // REENTREGA (outro processo, o pai)
      const out = await journal.completeSend(await f.scope(), jobId, claim);
      expect(out.reused).toBe(observado.effects === 1);
      if (!out.reused)
        expect(out).toMatchObject({ output: { messages: [{ message_id: message }] } });
      expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
      expect(await events(f.run, "action_sent")).toBe(1);
      expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 2 });
      // e mais uma entrega não duplica
      await expect(journal.completeSend(await f.scope(), jobId, claim)).resolves.toMatchObject({
        reused: true,
      });
      expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
    },
    120_000,
  );
});

describe("controle positivo do filho", () => {
  it("sem trigger e sem kill, o filho conclui (DONE) — o teste de SIGKILL mede algo que acontece", async () => {
    const { f, jobId, claim, accept } = await envioEnfileirado();
    await accept();
    const child = spawn(process.execPath, [...TSX_IMPORT, CHILD], {
      env: {
        ...process.env,
        DB_PORT: String(process.env.TEST_DB_PORT ?? 54329),
        ORG: GOV_ORG,
        ENROLLMENT: f.run,
        JOB: jobId,
        CLAIM_WORKER: claim.worker_id,
        CLAIM_AT: claim.acquired_at,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    expect(out).toContain('DONE {"reused":false}');
    expect(code).toBe(0);
    expect(await sendCounts(f.run)).toEqual({ effects: 1, succeeded: 1 });
  }, 60_000);
});
