import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  PgExecutionJournal,
  ExecutionTaskConfigurationError,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import type * as ContractModule from "@/lib/followup/execution-contract";
import { ExecutionInputChangedError } from "@/lib/followup/execution-journal";

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
const assertNoEffects = (counts: { tasks: number; effects: number; activities: number }) => {
  expect(counts).toEqual({ tasks: 0, effects: 0, activities: 0 });
};
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture(
  options: {
    owner?: string | null;
    contract?: 0 | 1;
    decision?: "condition" | "trigger" | "edit_lead_tag" | "move_lead" | "wait" | "repeat";
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
  // Inscrição legada (contrato 0) só existe sobre versão sem a chave: a 0710 faz toda inscrição herdar o
  // contrato da versão, então um grafo de contrato 1 nunca abriga inscrição de contrato 0.
  if (options.contract === 0) delete (graph as { execution_contract?: number }).execution_contract;
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

describe("diário transacional do motor existente — Postgres real", () => {
  it("vínculo com fila recusa job de outra organização e preserva histórico no expurgo", async () => {
    const f = await fixture(),
      handle = await f.begin();
    const otherOrg = randomUUID(),
      otherContact = randomUUID(),
      otherJob = randomUUID(),
      ownJob = randomUUID();
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Fila sintética B','Fila B')",
      [otherOrg, `q-${otherOrg}`],
    );
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Contato B')",
      [otherContact, otherOrg],
    );
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$5,'followup_turn','{}'),($3,$4,$6,'followup_turn','{}')",
      [otherJob, otherOrg, ownJob, GOV_ORG, otherContact, f.contact],
    );
    await expect(
      pool.query(
        "update followup_execution_attempts set job_id=$3 where organization_id=$1 and id=$2",
        [GOV_ORG, handle.attempt_id, otherJob],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      "update followup_execution_attempts set job_id=$3 where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id, ownJob],
    );
    const before = await pool.query(
      "select job_id,input_snapshot from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(before.rows[0].job_id).toBe(ownJob);
    await pool.query("delete from job_queue where organization_id=$1 and id=$2", [GOV_ORG, ownJob]);
    const after = await pool.query(
      "select job_id,input_snapshot from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(after.rows[0]).toEqual({ job_id: null, input_snapshot: before.rows[0].input_snapshot });
  });

  it("attachJob liga a tentativa ao job da própria inscrição, é idempotente e não reaponta", async () => {
    const f = await fixture(),
      handle = await f.begin(),
      scope = await f.scope();
    const mk = async (payload: Record<string, unknown>) => {
      const id = randomUUID();
      await pool.query(
        "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
        [id, GOV_ORG, f.contact, payload],
      );
      return id;
    };
    const own = { followup_enrollment_id: f.run, node_id: "task", source_step_key: "task:0" };
    const jobA = await mk(own),
      jobB = await mk(own),
      alheio = await mk({
        followup_enrollment_id: randomUUID(),
        node_id: "task",
        source_step_key: "task:0",
      }),
      outroNo = await mk({
        followup_enrollment_id: f.run,
        node_id: "end",
        source_step_key: "end:0",
      }),
      visitaAnterior = await mk({ ...own, source_step_key: "task:7" });
    const linked = () =>
      pool
        .query(
          "select job_id from followup_execution_attempts where organization_id=$1 and id=$2",
          [GOV_ORG, handle.attempt_id],
        )
        .then((r) => r.rows[0].job_id);
    for (const bad of [alheio, outroNo, visitaAnterior, randomUUID()]) {
      await expect(journal.attachJob(scope, handle, bad)).rejects.toMatchObject({
        code: "execution_job_not_found",
      });
    }
    expect(await linked()).toBeNull();
    await expect(journal.attachJob(scope, handle, jobA)).resolves.toEqual({ reused: false });
    await expect(journal.attachJob(scope, handle, jobA)).resolves.toEqual({ reused: true });
    await expect(journal.attachJob(scope, handle, jobB)).rejects.toMatchObject({
      code: "execution_job_conflict",
    });
    expect(await linked()).toBe(jobA);
  });

  it("repetição registra cada visita e conserva o total decidido na primeira resposta", async () => {
    const f = await fixture({ decision: "repeat" });
    let reads = 0;
    const deps = {
      db: {
        ...adapter,
        loadLastInboundBody: async () => {
          reads++;
          return "2";
        },
      },
      clock: () => new Date(),
      enqueueJob: async () => {},
    };
    for (let i = 0; i < 3; i++) await avancarEnrollmentAtivo(deps, await f.scope());
    expect(reads).toBe(1);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 3 });
    const attempts = await pool.query(
      `select s.visit,s.branch_id,a.output_snapshot from followup_execution_steps s
      join followup_execution_attempts a on a.organization_id=s.organization_id and a.step_id=s.id
      where s.organization_id=$1 and s.enrollment_id=$2 order by s.visit`,
      [GOV_ORG, f.run],
    );
    expect(attempts.rows).toEqual([
      {
        visit: 0,
        branch_id: "body",
        output_snapshot: { index: 1, total: 2, reason: "body", branch_id: "body" },
      },
      {
        visit: 1,
        branch_id: "body",
        output_snapshot: { index: 2, total: 2, reason: "body", branch_id: "body" },
      },
      {
        visit: 2,
        branch_id: "done",
        output_snapshot: { index: 2, total: 2, reason: "done", branch_id: "done" },
      },
    ]);
  });

  it("repetição sem quantidade legível não inventa zero no output", async () => {
    const f = await fixture({ decision: "repeat" });
    await avancarEnrollmentAtivo(
      {
        db: { ...adapter, loadLastInboundBody: async () => "não sei" },
        clock: () => new Date(),
        enqueueJob: async () => {},
      },
      await f.scope(),
    );
    const attempts = await pool.query(
      `select a.output_snapshot from followup_execution_steps s join followup_execution_attempts a
      on a.organization_id=s.organization_id and a.step_id=s.id where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, f.run],
    );
    expect(attempts.rows[0].output_snapshot).toEqual({
      index: null,
      total: null,
      branch_id: "else",
      reason: "unreadable",
    });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
  });

  it.each([false, true])(
    "resposta durante espera imune=%s respeita a configuração",
    async (immune) => {
      const f = await fixture({ decision: "wait", immune });
      const deps = {
        db: adapter,
        clock: () => new Date(),
        enqueueJob: async () => {
          throw new Error("unexpected_job");
        },
      };
      await avancarEnrollmentAtivo(deps, await f.scope());
      const parked = await f.scope();
      await adapter.insertEnrollmentEvent({
        organization_id: GOV_ORG,
        enrollment_id: f.run,
        node_id: "task",
        event_type: "inbound_woke",
        payload: {},
        idempotency_key: `task:${parked.steps_taken}:wake`,
      });
      await avancarEnrollmentAtivo(deps, await f.scope());
      expect(await f.scope()).toMatchObject({
        current_node_id: immune ? "task" : "end",
        steps_taken: immune ? 1 : 2,
      });
    },
  );

  it("falha transitória na retomada preserva prazo e passagem da espera", async () => {
    const f = await fixture({ decision: "wait" });
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      await f.scope(),
    );
    const scope = await f.scope(),
      first = await journal.begin(scope, {});
    if (first.kind !== "ready") throw new Error("expected_ready");
    await journal.fail(scope, first.handle, {
      code: "synthetic_resume_failure",
      message: "Falha sintética na retomada",
      category: "transient",
      retryable: true,
    });
    const next = await journal.begin(await f.scope(), {});
    if (next.kind !== "ready") throw new Error("expected_ready");
    expect(next.waiting_until).toBe(first.waiting_until);
    expect(next.input).toEqual(first.input);
    expect(next.handle).toMatchObject({ step_id: first.handle.step_id, attempt_no: 2, visit: 0 });
  });

  it.each([false, true])(
    "espera imune=%s retoma a mesma tentativa somente no prazo",
    async (immune) => {
      const f = await fixture({ decision: "wait", immune });
      let now = new Date();
      const deps = {
        db: adapter,
        clock: () => now,
        enqueueJob: async () => {
          throw new Error("wait_must_not_enqueue");
        },
      };
      await avancarEnrollmentAtivo(deps, await f.scope());
      const parked = await f.scope();
      expect(parked).toMatchObject({
        current_node_id: "task",
        steps_taken: 1,
        status: immune ? "dormente" : "active",
      });
      const attempts = () =>
        pool.query(
          `select a.id,a.status,a.output_recorded,a.output_snapshot,a.next_eval_at,s.visit from followup_execution_attempts a
      join followup_execution_steps s on s.id=a.step_id and s.organization_id=a.organization_id where s.organization_id=$1 and s.enrollment_id=$2`,
          [GOV_ORG, f.run],
        );
      const before = await attempts();
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ status: "waiting", output_recorded: false, visit: 0 });
      await avancarEnrollmentAtivo(deps, await f.scope());
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
      now = new Date(now.getTime() + 300001);
      // O prazo é medido no relógio do BANCO (o claim usa o mesmo): vencer a espera é mover o
      // prazo no banco, não só o relógio do processo.
      await pool.query(
        "update followup_execution_attempts set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
        [GOV_ORG, before.rows[0].id],
      );
      const vencida = (await attempts()).rows[0].next_eval_at;
      await avancarEnrollmentAtivo(deps, await f.scope());
      expect(await f.scope()).toMatchObject({
        current_node_id: "end",
        steps_taken: 2,
        status: "active",
      });
      const after = await attempts();
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({
        id: before.rows[0].id,
        status: "succeeded",
        output_recorded: true,
        output_snapshot: {
          mode: "fixed",
          scheduled_for: new Date(vencida).toISOString(),
          resumed_at: now.toISOString(),
        },
      });
    },
  );

  it("movimentação registra campos obrigatórios faltantes e aceita o Lead preenchido", async () => {
    const settings = (destination: string) => ({
      fields: [
        {
          key: "concorrente",
          label: "Concorrente",
          type: "text",
          obrigatorio_em: { etapas: [destination] },
        },
      ],
    });
    const missing = await fixture({ decision: "move_lead", settings });
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      await missing.scope(),
    );
    expect(await missing.scope()).toMatchObject({ status: "dead", steps_taken: 0 });
    const failed = await pool.query(
      `select a.error_snapshot from followup_execution_attempts a join followup_execution_steps s
      on s.id=a.step_id and s.organization_id=a.organization_id where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, missing.run],
    );
    expect(failed.rows[0].error_snapshot).toMatchObject({
      category: "configuration",
      retryable: false,
      details: { faltando: [{ chave: "concorrente", rotulo: "Concorrente" }] },
    });
    const filled = await fixture({ decision: "move_lead", settings });
    await pool.query("update crm_leads set custom_fields=$3 where organization_id=$1 and id=$2", [
      GOV_ORG,
      filled.lead,
      { concorrente: "ACME" },
    ]);
    const scope = await filled.scope(),
      handle = await filled.begin(scope);
    await journal.completeMove(scope, handle);
    expect(await filled.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
  });

  it("mover Lead confirma mudança, output, atividade e evento uma única vez", async () => {
    const f = await fixture({ decision: "move_lead" });
    const scope = await f.scope(),
      handle = await f.begin(scope);
    const results = await Promise.all([
      journal.completeMove(scope, handle),
      journal.completeMove(scope, handle),
    ]);
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
    expect(results[0]!.output).toEqual({
      lead_id: f.lead,
      from_stage_id: f.sourceStage,
      to_stage_id: f.destination,
    });
    expect(results[1]!.output).toEqual(results[0]!.output);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    const lead = await pool.query(
      "select stage_id,status from crm_leads where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    expect(lead.rows[0]).toMatchObject({ stage_id: f.destination, status: "open" });
    const events = await pool.query(
      "select payload from event_log where organization_id=$1 and entity_id=$2 and event_type='lead.stage_changed'",
      [GOV_ORG, f.lead],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      from_stage_id: f.sourceStage,
      to_stage_id: f.destination,
      service_origin: { kind: "continuation" },
    });
    const activities = await pool.query(
      "select count(*)::int as n from crm_lead_activities where organization_id=$1 and lead_id=$2 and type='stage_changed'",
      [GOV_ORG, f.lead],
    );
    expect(activities.rows[0].n).toBe(1);
  });

  it.each([
    { target: "lost" as const, code: "lost_reason_required" },
    // `reabertura_cria_novo` saiu desta lista em 30/10/2026: o funil não recusa
    // mais a saída de ganho/perdido (`modoDeReabertura`, lib/leads/reabertura.ts).
    { withoutLead: true, code: "execution_lead_required" },
    // `pipeline_immutable_use_clone` saiu desta lista em 12/11/2026 (Fase 5): o bloco Mover troca de funil o MESMO
    // negócio, como `/move-pipeline` — caso próprio logo abaixo.
  ])("movimentação recusa regra comercial sem efeito: $code", async ({ code, ...options }) => {
    const f = await fixture({ decision: "move_lead", ...options });
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      await f.scope(),
    );
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: code,
      current_node_id: "task",
      steps_taken: 0,
    });
    expect((await f.counts()).effects).toBe(0);
    const lead = await pool.query(
      "select stage_id from crm_leads where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    expect(lead.rows[0].stage_id).toBe(f.sourceStage);
  });

  it("movimentação para etapa ABERTA de outro funil troca o mesmo negócio de funil (Fase 5)", async () => {
    // Funil de destino PRÓPRIO, sem regras: o funil compartilhado do seed pode ganhar obrigatórios de outros testes.
    const outroFunil = randomUUID(),
      etapaAberta = randomUUID();
    await pool.query("insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,$3,$3,'{}')", [
      outroFunil,
      GOV_ORG,
      `destino-${outroFunil.slice(0, 8)}`,
    ]);
    await pool.query(
      "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberta','aberta',1000)",
      [etapaAberta, GOV_ORG, outroFunil],
    );
    const f = await fixture({ decision: "move_lead", targetStageId: etapaAberta });
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      await f.scope(),
    );
    // Se a troca for recusada, o motivo aparece aqui (e não só "o negócio não andou").
    expect(await f.scope()).toMatchObject({ last_error: null });
    const lead = await pool.query("select stage_id,pipeline_id from crm_leads where organization_id=$1 and id=$2", [
      GOV_ORG,
      f.lead,
    ]);
    expect(lead.rows[0]).toEqual({ stage_id: etapaAberta, pipeline_id: outroFunil });
  });

  it("movimentação para perda usa motivo válido e retorna a etapa efetivamente gravada", async () => {
    const f = await fixture({ decision: "move_lead", target: "lost", lostReason: "other" });
    const scope = await f.scope(),
      handle = await f.begin(scope);
    await journal.completeMove(scope, handle);
    const lead = await pool.query(
      "select stage_id,status,lost_reason from crm_leads where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    expect(lead.rows[0]).toMatchObject({
      stage_id: f.destination,
      status: "lost",
      lost_reason: "other",
    });
  });

  it("movimentação preserva alteração humana feita depois do início", async () => {
    const f = await fixture({ decision: "move_lead" }),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(
      "update crm_leads set title='Alterado por humano',updated_at=clock_timestamp() where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    await expect(journal.completeMove(scope, handle)).rejects.toBeInstanceOf(
      ExecutionInputChangedError,
    );
    expect((await f.counts()).effects).toBe(0);
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
  });

  it("falha antes de confirmar a tentativa desfaz movimento, evento, atividade e recibo", async () => {
    const f = await fixture({ decision: "move_lead" }),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(`create function public.test_move_crash() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_move_crash'; end; $$;
      create trigger test_move_crash before update on followup_execution_attempts
      for each row when (new.id='${handle.attempt_id}'::uuid and new.status='succeeded') execute function public.test_move_crash()`);
    try {
      await expect(journal.completeMove(scope, handle)).rejects.toThrow("synthetic_move_crash");
      const lead = await pool.query(
        "select stage_id from crm_leads where organization_id=$1 and id=$2",
        [GOV_ORG, f.lead],
      );
      expect(lead.rows[0].stage_id).toBe(f.sourceStage);
      const events = await pool.query(
        "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2 and event_type='lead.stage_changed'",
        [GOV_ORG, f.lead],
      );
      expect(events.rows[0].n).toBe(0);
      const activities = await pool.query(
        "select count(*)::int as n from crm_lead_activities where organization_id=$1 and lead_id=$2 and type='stage_changed'",
        [GOV_ORG, f.lead],
      );
      expect(activities.rows[0].n).toBe(0);
      expect((await f.counts()).effects).toBe(0);
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
    } finally {
      await pool.query(
        "drop trigger test_move_crash on followup_execution_attempts; drop function public.test_move_crash()",
      );
    }
  });

  it("nó de tags preserva tags anteriores e confirma evento, atividade, output e avanço", async () => {
    const f = await fixture({ decision: "edit_lead_tag" });
    await pool.query(
      "update crm_leads set tags=array['anterior'] where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    await avancarEnrollmentAtivo(
      {
        db: adapter,
        clock: () => new Date(),
        enqueueJob: async () => {
          throw new Error("unexpected_job");
        },
      },
      await f.scope(),
    );
    const lead = await pool.query("select tags from crm_leads where organization_id=$1 and id=$2", [
      GOV_ORG,
      f.lead,
    ]);
    expect(lead.rows[0].tags).toEqual(["anterior", "vip"]);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    const effect = await pool.query(
      "select result_snapshot from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
      [GOV_ORG, f.run],
    );
    expect(effect.rows[0].result_snapshot).toEqual({
      lead_id: f.lead,
      added_tags: ["vip"],
      tags: ["anterior", "vip"],
    });
    const events = await pool.query(
      "select payload,metadata from event_log where organization_id=$1 and entity_id=$2 and event_type='lead.tag_added'",
      [GOV_ORG, f.lead],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      payload: { added_tags: ["vip"], service_origin: { kind: "continuation" } },
      metadata: { caused_by_rule: `followup:${f.run}` },
    });
    const activities = await pool.query(
      "select count(*)::int as n from crm_lead_activities where organization_id=$1 and lead_id=$2 and type='lead_edited'",
      [GOV_ORG, f.lead],
    );
    expect(activities.rows[0].n).toBe(1);
  });

  it("conclusões concorrentes de tags reutilizam o mesmo recibo e emitem um único evento", async () => {
    const f = await fixture({ decision: "edit_lead_tag" }),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const results = await Promise.all([
      journal.completeTags(scope, handle),
      journal.completeTags(scope, handle),
    ]);
    expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
    expect(results[0]!.output).toEqual(results[1]!.output);
    const events = await pool.query(
      "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2 and event_type='lead.tag_added'",
      [GOV_ORG, f.lead],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it("tag adicionada por outra pessoa durante a tentativa não é apagada", async () => {
    const f = await fixture({ decision: "edit_lead_tag" }),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(
      "update crm_leads set tags=array['humano'] where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    await expect(journal.completeTags(scope, handle)).rejects.toBeInstanceOf(
      ExecutionInputChangedError,
    );
    await journal.fail(scope, handle, {
      code: "execution_input_changed",
      message: "Os dados mudaram durante a tentativa.",
      category: "transient",
      retryable: true,
    });
    const fresh = await f.scope(),
      next = await f.begin(fresh);
    expect(next.step_id).toBe(handle.step_id);
    expect(next.attempt_no).toBe(2);
    const result = await journal.completeTags(fresh, next);
    expect(result.output.tags).toEqual(["humano", "vip"]);
    expect(result.output.added_tags).toEqual(["vip"]);
  });

  it("sem Lead explícito não etiqueta outro Lead nem o contato por fallback", async () => {
    const f = await fixture({ decision: "edit_lead_tag", withoutLead: true });
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      await f.scope(),
    );
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_lead_required",
      steps_taken: 0,
    });
    expect((await f.counts()).effects).toBe(0);
    const lead = await pool.query("select tags from crm_leads where organization_id=$1 and id=$2", [
      GOV_ORG,
      f.lead,
    ]);
    expect(lead.rows[0].tags ?? []).toEqual([]);
  });

  it("tag já presente retorna saída real sem produzir alteração ou evento fictício", async () => {
    const f = await fixture({ decision: "edit_lead_tag" });
    await pool.query("update crm_leads set tags=array['vip'] where organization_id=$1 and id=$2", [
      GOV_ORG,
      f.lead,
    ]);
    const scope = await f.scope(),
      handle = await f.begin(scope),
      result = await journal.completeTags(scope, handle);
    expect(result.output).toEqual({ lead_id: f.lead, added_tags: [], tags: ["vip"] });
    const events = await pool.query(
      "select count(*)::int as n from event_log where organization_id=$1 and entity_id=$2 and event_type='lead.tag_added'",
      [GOV_ORG, f.lead],
    );
    expect(events.rows[0].n).toBe(0);
  });

  it.each([true, false])(
    "motor registra a aresta e os checks reais (%s), mesmo com destino compartilhado",
    async (matched) => {
      const f = await fixture({ decision: "condition" });
      if (matched)
        await pool.query(
          "update crm_leads set tags=array['vip'] where organization_id=$1 and id=$2",
          [GOV_ORG, f.lead],
        );
      const deps = {
        db: adapter,
        clock: () => new Date(),
        enqueueJob: async () => {
          throw new Error("pure_decision_must_not_enqueue");
        },
      };
      await avancarEnrollmentAtivo(deps, await f.scope());
      expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
      await avancarEnrollmentAtivo(deps, await f.scope());
      expect(await f.scope()).toMatchObject({
        status: "completed",
        steps_taken: 2,
        outcome: "exhausted",
      });
      const attempts = await pool.query(
        `select s.node_id,s.branch_id,a.output_snapshot from followup_execution_steps s
      join followup_execution_attempts a on a.organization_id=s.organization_id and a.step_id=s.id
      where s.organization_id=$1 and s.enrollment_id=$2 order by s.entered_at`,
        [GOV_ORG, f.run],
      );
      expect(attempts.rows[0]).toMatchObject({
        node_id: "task",
        branch_id: String(matched),
        output_snapshot: { matched, branch_id: String(matched), checks: [{ index: 0, matched }] },
      });
      expect(attempts.rows[1]).toMatchObject({
        node_id: "end",
        output_snapshot: { outcome: "exhausted", note: null },
      });
      const events = await pool.query(
        "select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='node_advanced'",
        [GOV_ORG, f.run],
      );
      expect(events.rows[0].payload).toMatchObject({
        edge_id: matched ? "true-edge" : "false-edge",
        branch_id: String(matched),
        next_node_id: "end",
      });
      expect((await f.counts()).effects).toBe(0);
    },
  );

  it("acionamento sem planejamento persiste seus IDs reais antes do próximo nó", async () => {
    const f = await fixture({ decision: "trigger" });
    await avancarEnrollmentAtivo(
      {
        db: adapter,
        clock: () => new Date(),
        enqueueJob: async () => {
          throw new Error("unexpected_job");
        },
      },
      await f.scope(),
    );
    const attempts = await pool.query(
      `select a.output_snapshot from followup_execution_attempts a
      join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
      where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, f.run],
    );
    expect(attempts.rows[0].output_snapshot).toMatchObject({
      contact_id: f.contact,
      lead_id: f.lead,
    });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
  });

  it("repetição do begin reutiliza os fatos resolvidos, sem avaliar de novo com cadastro mais recente", async () => {
    const f = await fixture({ decision: "condition" }),
      scope = await f.scope();
    await journal.begin(scope, {
      facts: { lead_stage: GOV_STAGE, tags: ["vip"], steps_taken: 0, last_outcome: null },
    });
    await pool.query(
      "update crm_leads set tags=array[]::text[] where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    await avancarEnrollmentAtivo(
      { db: adapter, clock: () => new Date(), enqueueJob: async () => {} },
      scope,
    );
    const attempt = await pool.query(
      `select a.input_snapshot,a.output_snapshot from followup_execution_attempts a
      join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
      where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, f.run],
    );
    expect(attempt.rows[0]).toMatchObject({
      input_snapshot: { facts: { tags: ["vip"] } },
      output_snapshot: { matched: true, branch_id: "true" },
    });
  });
  it("registra início antes do efeito e repete o begin do mesmo lease sem criar tentativa nova", async () => {
    const f = await fixture(),
      scope = await f.scope();
    const a = await f.begin(scope),
      b = await f.begin(scope);
    expect(b).toEqual(a);
    const { rows } = await pool.query(
      "select status,input_snapshot,config_snapshot,lease_revision from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, a.attempt_id],
    );
    expect(rows[0]).toMatchObject({
      status: "running",
      input_snapshot: {
        requested: { lead_id: f.lead },
        resolved: { task: { lead_id: f.lead }, lead: { id: f.lead } },
      },
      config_snapshot: { prioridade: "high" },
    });
    expect(Number(rows[0].lease_revision)).toBe(scope.revision);
    expect(await f.counts()).toEqual({ tasks: 0, effects: 0, activities: 0 });
  });

  it("confirma tarefa, atividade, recibo, tentativa e avanço no mesmo commit; ACK repetido só reutiliza", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const first = await journal.completeTask(scope, handle);
    expect(first.reused).toBe(false);
    expect(first.output).toMatchObject({ contact_id: f.contact, lead_id: f.lead });
    const again = await journal.completeTask(scope, handle);
    expect(again).toEqual({ output: first.output, reused: true });
    expect(await f.counts()).toEqual({ tasks: 1, effects: 1, activities: 1 });
    expect(await f.scope()).toMatchObject({
      current_node_id: "end",
      steps_taken: 1,
      status: "active",
    });
    const { rows } = await pool.query(
      `select a.status,a.output_recorded,a.output_snapshot,s.status as step_status,t.title
      from followup_execution_attempts a join followup_execution_steps s on s.id=a.step_id and s.organization_id=a.organization_id
      join crm_tasks t on t.id=(a.output_snapshot->>'task_id')::uuid and t.organization_id=a.organization_id
      where a.organization_id=$1 and a.id=$2`,
      [GOV_ORG, handle.attempt_id],
    );
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      step_status: "succeeded",
      output_recorded: true,
      output_snapshot: first.output,
      title: "Ligar para Ana Souza sobre Contrato original",
    });
    const audit = await pool.query(
      "select count(*)::int as n from api_audit_log where organization_id=$1 and resource_id=$2 and action='crm_task.created'",
      [GOV_ORG, first.output.task_id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("duas conclusões concorrentes produzem uma tarefa e um recibo", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const outcomes = await Promise.all([
      journal.completeTask(scope, handle),
      journal.completeTask(scope, handle),
    ]);
    expect(outcomes.map((x) => x.reused).sort()).toEqual([false, true]);
    expect(outcomes[0]!.output).toEqual(outcomes[1]!.output);
    expect(await f.counts()).toEqual({ tasks: 1, effects: 1, activities: 1 });
  });

  it("entrada resolvida é durável e a tarefa usa os dados da tentativa, mesmo após mudança do cadastro", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(
      "update contacts set name='Nome posterior' where organization_id=$1 and id=$2",
      [GOV_ORG, f.contact],
    );
    await pool.query(
      "update crm_leads set title='Título posterior' where organization_id=$1 and id=$2",
      [GOV_ORG, f.lead],
    );
    const result = await journal.completeTask(scope, handle);
    const saved = await pool.query(
      "select title from crm_tasks where organization_id=$1 and id=$2",
      [GOV_ORG, result.output.task_id],
    );
    expect(saved.rows[0].title).toBe("Ligar para Ana Souza sobre Contrato original");
    const input = await pool.query(
      "select input_snapshot from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(input.rows[0].input_snapshot.resolved).toMatchObject({
      contact: { name: "Ana Souza" },
      lead: { title: "Contrato original" },
      task: { title: saved.rows[0].title },
    });
  });

  it("falha após INSERTs e antes do commit desfaz tarefa, atividade, recibo e avanço", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(`create or replace function public.test_execution_crash() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_crash_before_commit'; end; $$;
      create trigger test_execution_crash before update on followup_execution_attempts
      for each row when (new.id='${handle.attempt_id}'::uuid and new.status='succeeded') execute function public.test_execution_crash()`);
    try {
      await expect(journal.completeTask(scope, handle)).rejects.toThrow(
        "synthetic_crash_before_commit",
      );
      assertNoEffects(await f.counts());
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
      const attempt = await pool.query(
        "select status from followup_execution_attempts where organization_id=$1 and id=$2",
        [GOV_ORG, handle.attempt_id],
      );
      expect(attempt.rows[0].status).toBe("running");
    } finally {
      await pool.query(
        "drop trigger test_execution_crash on followup_execution_attempts; drop function public.test_execution_crash()",
      );
    }
    await journal.completeTask(scope, handle);
    expect(await f.counts()).toEqual({ tasks: 1, effects: 1, activities: 1 });
  });

  it("contraprova: retirar BEGIN/ROLLBACK faz a mesma sonda detectar efeitos parciais", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const withoutTransactions = {
      connect: async () => {
        const actual = await pool.connect();
        return {
          query: async (text: string, args?: unknown[]) =>
            /^(begin|commit|rollback)$/i.test(text.trim())
              ? { rows: [], rowCount: 0 }
              : actual.query(text, args),
          on: (event: "error", listener: (error: Error) => void) => actual.on(event, listener),
          off: (event: "error", listener: (error: Error) => void) => actual.off(event, listener),
          release: () => actual.release(),
        };
      },
    } as unknown as pg.Pool;
    const broken = new PgExecutionJournal(withoutTransactions);
    await pool.query(`create or replace function public.test_execution_negative_crash() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_negative_crash'; end; $$;
      create trigger test_execution_negative_crash before update on followup_execution_attempts
      for each row when (new.id='${handle.attempt_id}'::uuid and new.status='succeeded') execute function public.test_execution_negative_crash()`);
    try {
      await expect(broken.completeTask(scope, handle)).rejects.toThrow("synthetic_negative_crash");
      const partial = await f.counts();
      expect(partial).toEqual({ tasks: 1, effects: 1, activities: 1 });
      expect(() => assertNoEffects(partial)).toThrow();
    } finally {
      await pool.query(
        "drop trigger test_execution_negative_crash on followup_execution_attempts; drop function public.test_execution_negative_crash()",
      );
    }
  });

  it("reclaim abre outra tentativa na mesma passagem e impede o worker antigo de escrever", async () => {
    const f = await fixture(),
      original = await f.scope(),
      old = await f.begin(original);
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    const fresh = await f.scope(),
      next = await f.begin(fresh);
    expect(next.step_id).toBe(old.step_id);
    expect(next.visit).toBe(0);
    expect(next.attempt_no).toBe(2);
    await expect(journal.completeTask(original, old)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    await journal.completeTask(fresh, next);
    expect(await f.counts()).toEqual({ tasks: 1, effects: 1, activities: 1 });
  });

  it.each(["paused_manual", "cancelled"])("%s impede conclusão atrasada", async (status) => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(
      "update followup_enrollments set status=$3 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run, status],
    );
    await expect(journal.completeTask(scope, handle)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(await f.counts()).toEqual({ tasks: 0, effects: 0, activities: 0 });
    expect((await f.scope()).status).toBe(status);
  });

  it("falha de configuração é registrada e para com aviso; não vira sucesso nem duplica o aviso", async () => {
    const f = await fixture({ owner: null }),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await expect(journal.completeTask(scope, handle)).rejects.toBeInstanceOf(
      ExecutionTaskConfigurationError,
    );
    const error = {
      code: "sem_dono",
      message: "O Lead não tem responsável.",
      category: "configuration",
      retryable: false,
    } as const;
    await journal.fail(scope, handle, error);
    await journal.fail(scope, handle, error);
    expect(await f.counts()).toEqual({ tasks: 0, effects: 0, activities: 0 });
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "sem_dono",
      current_node_id: "task",
      steps_taken: 0,
    });
    const attempts = await pool.query(
      "select status,error_snapshot,output_recorded from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(attempts.rows[0]).toMatchObject({
      status: "failed",
      error_snapshot: error,
      output_recorded: false,
    });
    const notices = await pool.query(
      "select count(*)::int as n from agent_inbox_items where organization_id=$1 and ref_id=$2 and kind='followup_dead'",
      [GOV_ORG, f.run],
    );
    expect(notices.rows[0].n).toBe(1);
  });

  it("efeito pendente no lease interrompido exige reconciliação e não abre outra tentativa", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    await pool.query(
      `insert into followup_execution_effects(organization_id,enrollment_id,step_id,effect_key,operation,status)
      values($1,$2,$3,$4,'external_test','pending')`,
      [GOV_ORG, f.run, handle.step_id, randomUUID()],
    );
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    expect(await journal.begin(await f.scope(), {})).toEqual({
      kind: "reconcile",
      step_id: handle.step_id,
      attempt_id: handle.attempt_id,
    });
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_lease_interrupted",
    });
    const attempts = await pool.query(
      "select count(*)::int as n from followup_execution_attempts where organization_id=$1 and step_id=$2",
      [GOV_ORG, handle.step_id],
    );
    expect(attempts.rows[0].n).toBe(1);
    expect((await f.counts()).tasks).toBe(0);
  });

  it("interrupções repetidas também respeitam o orçamento de tentativas", async () => {
    const f = await fixture();
    await pool.query(
      "update followup_enrollments set max_attempts=1 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    const first = await f.begin();
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    const second = await f.begin();
    expect(second.attempt_no).toBe(2);
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '4 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    expect(await journal.begin(await f.scope(), {})).toEqual({
      kind: "stopped",
      step_id: first.step_id,
      attempt_id: second.attempt_id,
    });
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_attempt_budget_exhausted",
    });
    expect((await f.counts()).tasks).toBe(0);
  });

  it("organização forjada não começa nem conclui a execução", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const forged = { ...scope, organization_id: randomUUID() };
    await expect(journal.begin(forged, {})).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    await expect(
      journal.completeTask(forged, { ...handle, organization_id: forged.organization_id }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(await f.counts()).toEqual({ tasks: 0, effects: 0, activities: 0 });
  });

  it("origem do contrato novo é imutável; contrato legado não é convertido em execução nova", async () => {
    const f = await fixture();
    for (const patch of [
      "execution_contract=0",
      "execution_mode='test'",
      `lead_id='${randomUUID()}'`,
      "service_boundary='{}'::jsonb",
    ]) {
      await expect(
        pool.query(`update followup_enrollments set ${patch} where organization_id=$1 and id=$2`, [
          GOV_ORG,
          f.run,
        ]),
      ).rejects.toMatchObject({ code: "42501", message: "followup_execution_origin_immutable" });
    }
    const legacy = await fixture({ contract: 0 });
    await expect(
      pool.query(
        "update followup_enrollments set execution_contract=1 where organization_id=$1 and id=$2",
        [GOV_ORG, legacy.run],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
