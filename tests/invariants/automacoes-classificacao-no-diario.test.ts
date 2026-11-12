import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { ultimoDesfechoDe, type EnrollmentRow } from "@/lib/followup/node-handlers";
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
const journal = new PgExecutionJournal(pool);
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture(
  options: {
    owner?: string | null;
    contract?: 0 | 1;
    decision?:
      | "ai_classify"
      | "action"
      | "condition"
      | "trigger"
      | "edit_lead_tag"
      | "move_lead"
      | "wait"
      | "repeat";
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
                        : options.decision === "ai_classify"
                          ? {
                              classes: ["quente", "frio"],
                              grace_timeout_ms: 900_000,
                              target: "last_reply",
                            }
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
    if (options.decision === "ai_classify")
      (variant as { edges: unknown }).edges = [
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
      ];
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

describe("classificação por IA no diário — Postgres real", () => {
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
  const events = async (run: string, type: string) =>
    (
      await pool.query(
        "select payload from followup_enrollment_events where enrollment_id=$1 and event_type=$2 order by created_at",
        [run, type],
      )
    ).rows.map((r) => r.payload as Record<string, unknown>);
  const attempts = async (run: string) =>
    (
      await pool.query(
        `select a.id,a.status,a.output_snapshot,s.status as step_status,s.branch_id
         from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where s.organization_id=$1 and s.enrollment_id=$2 order by a.attempt_no`,
        [GOV_ORG, run],
      )
    ).rows;
  const joinRows = async (attempt: string) =>
    (
      await pool.query(
        "select job_id from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
        [GOV_ORG, attempt],
      )
    ).rowCount;
  /** Simula um novo claim da inscrição (outro lease), como acontece quando um tick a reclama. */
  const novoLease = (run: string) =>
    pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );

  async function emVoo() {
    const f = await fixture({ decision: "ai_classify" });
    const handle = await f.begin();
    const j1 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, j1);
    return { f, handle, j1 };
  }
  const reentrada = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const begun = await journal.begin(await f.scope(), {
      contact_id: f.contact,
      lead_id: f.lead,
      purpose: "classify",
    });
    if (begun.kind !== "ready") throw new Error("expected_ready");
    return begun.handle;
  };

  it("classificado: aresta pela classe, output do contrato, evento ai_classified e avanço juntos", async () => {
    const { f, j1 } = await emVoo();
    const out = await journal.completeClassification(await f.scope(), j1, "quente");
    expect(out).toMatchObject({
      reused: false,
      output: { classification: "quente", branch_id: "quente", reason: "classified" },
    });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    const ev = await events(f.run, "ai_classified");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ class: "quente", next_node_id: "end" });
    // O que o motor lê depois como "desfecho do passo anterior" bate com o que foi gravado.
    expect(
      ultimoDesfechoDe(
        (
          await pool.query(
            "select event_type,payload from followup_enrollment_events where enrollment_id=$1 order by created_at",
            [f.run],
          )
        ).rows,
      ),
    ).toBe("quente");
    expect(await attempts(f.run)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        step_status: "succeeded",
        branch_id: "quente",
      }),
    ]);
  });

  it("reenfileirar a classificação NÃO fecha a tentativa em voo; o primeiro job a concluir vence", async () => {
    const { f, handle, j1 } = await emVoo();
    await novoLease(f.run); // outro tick reclama a inscrição: o lease da tentativa já não é o atual
    const again = await reentrada(f);
    expect(again.attempt_id).toBe(handle.attempt_id); // mesma tentativa, não uma segunda
    const rows = await attempts(f.run);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "running" });
    const j2 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), again, j2);
    expect(await joinRows(handle.attempt_id)).toBe(2);

    // O job NOVO conclui primeiro...
    await expect(
      journal.completeClassification(await f.scope(), j2, "quente"),
    ).resolves.toMatchObject({
      reused: false,
    });
    // ...e o job ANTIGO, que ainda estava na fila, chega tarde: no-op, sem segundo evento nem avanço.
    await expect(
      journal.completeClassification(await f.scope(), j1, "frio"),
    ).resolves.toMatchObject({
      reused: true,
    });
    expect(await events(f.run, "ai_classified")).toHaveLength(1);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    expect(await attempts(f.run)).toHaveLength(1);
  });

  it("o envio continua recusando um segundo job na mesma tentativa (só a classificação aceita vários)", async () => {
    const f = await fixture({ decision: "action" });
    const handle = await f.begin();
    const a = await mkJob(f.contact, own(f.run));
    const b = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, a);
    await expect(journal.attachJob(await f.scope(), handle, b)).rejects.toMatchObject({
      code: "execution_job_conflict",
    });
    expect(await joinRows(handle.attempt_id)).toBe(1);
  });

  it("no_reply: a carência vence sem chamar o modelo; o desfecho entra como node_advanced com class", async () => {
    const { f, j1 } = await emVoo();
    await novoLease(f.run);
    const again = await reentrada(f);
    await expect(
      journal.completeNoReply(await f.scope(), again, { next_node_id: "end" }),
    ).resolves.toEqual({ reused: false });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    const [row] = await attempts(f.run);
    expect(row).toMatchObject({
      status: "succeeded",
      step_status: "succeeded",
      branch_id: "no_reply",
    });
    expect(row.output_snapshot).toEqual({
      classification: null,
      branch_id: "no_reply",
      reason: "no_reply",
    });
    const ev = await events(f.run, "node_advanced");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ class: "no_reply", next_node_id: "end" });
    // O job de classificação que ainda estava na fila fica obsoleto: no-op.
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).resolves.toMatchObject({
      reused: true,
    });
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
  });

  it("classe sem ramo (e sem padrão): recusa, nada avança nem é gravado", async () => {
    const { f, j1 } = await emVoo();
    await expect(journal.completeClassification(await f.scope(), j1, "frio")).rejects.toMatchObject(
      {
        code: "execution_edge_missing",
      },
    );
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
    expect(await attempts(f.run)).toEqual([expect.objectContaining({ status: "running" })]);
  });

  it("job de outra inscrição não conclui a classificação", async () => {
    const { f } = await emVoo();
    const alheio = await mkJob(f.contact, { ...own(f.run), followup_enrollment_id: randomUUID() });
    await expect(
      journal.completeClassification(await f.scope(), alheio, "quente"),
    ).rejects.toMatchObject({
      code: "execution_attempt_not_linked",
    });
    expect(await f.scope()).toMatchObject({ current_node_id: "task" });
  });

  it("job reenfileirado cujo vínculo nunca aconteceu conclui pelo payload, mesmo com outro job já ligado", async () => {
    const { f, handle, j1 } = await emVoo();
    const j2 = await mkJob(f.contact, own(f.run)); // criado depois da tentativa; attachJob "falhou"
    await expect(
      journal.completeClassification(await f.scope(), j2, "quente"),
    ).resolves.toMatchObject({
      reused: false,
    });
    expect(await joinRows(handle.attempt_id)).toBe(2); // j1 (attach) + j2 (religado)
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).resolves.toMatchObject({
      reused: true,
    });
  });

  it("motor: a carência vence ⇒ no_reply registrado no diário, sem chamar o modelo, sem tentativa nova", async () => {
    const f = await fixture({ decision: "ai_classify" });
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
    // Entrada do nó: abre a tentativa, enfileira o turno de classificação e liga o job.
    await avancarEnrollmentAtivo(deps, await f.scope());
    expect(jobs).toHaveLength(1);
    const [first] = await attempts(f.run);
    expect(first).toMatchObject({ status: "running" });
    expect(await joinRows(first.id)).toBe(1);

    // A carência vence: o inscrito é reclamado de novo, já vencido, e o motor decide no_reply.
    await pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second',claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    await avancarEnrollmentAtivo(
      { ...deps, clock: () => new Date(Date.now() + 16 * 60_000) },
      await f.scope(),
    );
    expect(await f.scope()).toMatchObject({ current_node_id: "end" });
    const rows = await attempts(f.run);
    expect(rows).toHaveLength(1); // a MESMA tentativa foi concluída, nenhuma outra foi aberta
    expect(rows[0]).toMatchObject({ status: "succeeded", branch_id: "no_reply" });
    expect(jobs).toHaveLength(1); // nenhum job novo: no_reply não chama o modelo
  });
});
