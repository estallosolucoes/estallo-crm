import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
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
    classify?: { config?: Record<string, unknown>; edges?: unknown[]; extraNodes?: unknown[] };
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
    if (options.classify?.config)
      (variant.nodes[0] as { config: unknown }).config = options.classify.config;
    if (options.classify?.edges) (variant as { edges: unknown }).edges = options.classify.edges;
    if (options.classify?.extraNodes)
      (variant.nodes as unknown[]).push(...options.classify.extraNodes);
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

import { completeTurnForEnrollment } from "@/lib/followup/turn-bridge";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const END2 = {
  id: "end2",
  type: "end",
  label: "Fim2",
  position: { x: 0, y: 200 },
  config: { outcome: "exhausted" },
};
const declared = (branches: { id: string; label: string }[]) => ({
  classes: branches.map((b) => b.label),
  branches,
  grace_timeout_ms: 900_000,
  target: "last_reply",
});
const br = (id: string) => ({ type: "branch", branch_id: id });
const cm = (value: string) => ({ type: "class_match", value });

describe("ATAQUE ai_classify/0706 — Postgres real", () => {
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
        `select a.id,a.attempt_no,a.status,a.output_snapshot,s.status as step_status,s.branch_id,s.visit
         from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where s.organization_id=$1 and s.enrollment_id=$2 order by s.visit,a.attempt_no`,
        [GOV_ORG, run],
      )
    ).rows;
  const novoLease = (run: string) =>
    pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  async function emVoo(options: Parameters<typeof fixture>[0] = {}) {
    const f = await fixture({ decision: "ai_classify", ...options });
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
    if (begun.kind !== "ready") throw new Error("expected_ready:" + begun.kind);
    return begun.handle;
  };
  const bridgeDb = { ...adapter, assertFollowupJob: undefined } as typeof adapter;
  const turno = async (
    f: { run: string },
    result: Parameters<typeof completeTurnForEnrollment>[4],
    jobId: string,
  ) => completeTurnForEnrollment(bridgeDb, GOV_ORG, f.run, "task", result, undefined, jobId);

  // (1)
  it("(1) corrida completeClassification x completeNoReply na mesma tentativa: exatamente um vence (12 rodadas)", async () => {
    const wins = { classified: 0, no_reply: 0 };
    for (let i = 0; i < 12; i++) {
      const { f, j1 } = await emVoo();
      await novoLease(f.run);
      const h2 = await reentrada(f);
      const scope = await f.scope();
      const settled = await Promise.allSettled([
        journal.completeClassification(scope, j1, "quente"),
        journal.completeNoReply(scope, h2, { next_node_id: "end" }),
      ]);
      for (const s of settled)
        if (s.status === "rejected") expect(s.reason).toBeInstanceOf(StaleServiceBoundaryError);
      const fresh = settled.filter(
        (s) => s.status === "fulfilled" && (s.value as { reused: boolean }).reused === false,
      );
      expect(fresh).toHaveLength(1);
      const cls = await events(f.run, "ai_classified");
      const nr = (await events(f.run, "node_advanced")).filter((p) => p.class === "no_reply");
      expect(cls.length + nr.length).toBe(1);
      const rows = await attempts(f.run);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "succeeded", step_status: "succeeded" });
      expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
      expect((rows[0].output_snapshot as { reason: string }).reason).toBe(
        cls.length ? "classified" : "no_reply",
      );
      if (cls.length) wins.classified++;
      else wins.no_reply++;
    }
    console.info("corrida (1) vencedores:", JSON.stringify(wins));
  }, 120_000);

  // (2)
  it("(2) dois completeClassification concorrentes (J1 quente / J2 frio): um evento, uma aresta, o perdedor reused (10 rodadas)", async () => {
    for (let i = 0; i < 10; i++) {
      const { f, handle, j1 } = await emVoo({
        classify: {
          config: declared([
            { id: "hot", label: "quente" },
            { id: "cold", label: "frio" },
          ]),
          edges: [
            { id: "e-hot", source: "task", target: "end", priority: 5, condition: br("hot") },
            { id: "e-cold", source: "task", target: "end2", priority: 5, condition: br("cold") },
            { id: "e-nr", source: "task", target: "end", priority: 5, condition: br("no_reply") },
          ],
          extraNodes: [END2],
        },
      });
      await novoLease(f.run);
      const again = await reentrada(f);
      const j2 = await mkJob(f.contact, own(f.run));
      await journal.attachJob(await f.scope(), again, j2);
      const scope = await f.scope();
      const settled = await Promise.allSettled([
        journal.completeClassification(scope, j1, "quente"),
        journal.completeClassification(scope, j2, "frio"),
      ]);
      for (const s of settled)
        if (s.status === "rejected") expect(s.reason).toBeInstanceOf(StaleServiceBoundaryError);
      const ev = await events(f.run, "ai_classified");
      expect(ev).toHaveLength(1);
      const rows = await attempts(f.run);
      expect(rows).toHaveLength(1);
      const out = rows[0].output_snapshot as { classification: string };
      expect(out.classification).toBe(ev[0]!.class);
      expect((await f.scope()).current_node_id).toBe(
        out.classification === "quente" ? "end" : "end2",
      );
      expect(
        settled.filter((s) => s.status === "fulfilled" && !(s.value as { reused: boolean }).reused),
      ).toHaveLength(1);
      expect(handle.attempt_id).toBe(rows[0].id);
    }
  }, 120_000);

  // (3)
  it("(3a) worker MORTO: begin reaproveita a MESMA tentativa só até o limite do contador (0708) e então CONSOME o orçamento até 'stopped'", async () => {
    const { f, handle } = await emVoo();
    for (let i = 1; i <= 5; i++) {
      await novoLease(f.run);
      const h = await reentrada(f);
      expect(h.attempt_id).toBe(handle.attempt_id);
      expect(h.attempt_no).toBe(1);
    }
    // Antes da 0708 o laço acima seguia para sempre dentro da janela de 24 h (ACHADO: sem teto).
    let kind = "ready";
    for (let i = 0; i < 80 && kind === "ready"; i++) {
      await novoLease(f.run);
      kind = (
        await journal.begin(await f.scope(), { contact_id: f.contact, lead_id: f.lead, purpose: "classify" })
      ).kind;
    }
    expect(kind).toBe("stopped");
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_attempt_budget_exhausted",
    });
    const rows = await attempts(f.run);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]).toMatchObject({ attempt_no: 1, status: "failed" });
  }, 120_000);

  it("(3a-controle) o mesmo cenário num nó action CONSOME o orçamento até 'stopped'", async () => {
    const f = await fixture({ decision: "action" });
    let kind = "ready";
    for (let i = 0; i < 12 && kind === "ready"; i++) {
      await novoLease(f.run);
      const b = await journal.begin(await f.scope(), { contact_id: f.contact, lead_id: f.lead });
      kind = b.kind;
    }
    expect(kind).toBe("stopped");
  }, 60_000);

  it("(3b) NÃO reaproveita quando é outra passagem: nó revisitado abre passagem nova; job órfão da visita antiga é recusado", async () => {
    const { f, j1 } = await emVoo({
      classify: {
        edges: [
          { id: "loop", source: "task", target: "task", priority: 5, condition: cm("quente") },
          { id: "nr", source: "task", target: "end", priority: 5, condition: cm("no_reply") },
        ],
      },
    });
    const orfao = await mkJob(f.contact, own(f.run)); // nasce ANTES da visita 1
    await journal.completeClassification(await f.scope(), j1, "quente"); // volta para 'task'
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes', next_eval_at=now() where id=$1",
      [f.run],
    );
    const h1 = await reentrada(f);
    const rows = await attempts(f.run);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ visit: 1, attempt_no: 1, status: "running" });
    expect(h1.attempt_id).toBe(rows[1].id);
    expect(h1.attempt_id).not.toBe(rows[0].id);
    expect(rows[0].status).toBe("succeeded");
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).resolves.toMatchObject({ reused: true });
    await expect(
      journal.completeClassification(await f.scope(), orfao, "quente"),
    ).rejects.toMatchObject({ code: "execution_attempt_not_linked" });
    expect((await attempts(f.run))[1].status).toBe("running");
  }, 60_000);

  // (4)
  it("(4i) rótulo repetido: vence o PRIMEIRO ramo declarado, determinístico", async () => {
    const { f, j1 } = await emVoo({
      classify: {
        config: declared([
          { id: "b1", label: "Quente" },
          { id: "b2", label: "Quente" },
        ]),
        edges: [
          { id: "e1", source: "task", target: "end", condition: br("b1") },
          { id: "e2", source: "task", target: "end2", condition: br("b2") },
          { id: "e3", source: "task", target: "end", condition: br("no_reply") },
        ],
        extraNodes: [END2],
      },
    });
    await journal.completeClassification(await f.scope(), j1, "Quente");
    expect((await attempts(f.run))[0].output_snapshot).toMatchObject({ branch_id: "b1" });
    expect((await f.scope()).current_node_id).toBe("end");
  });

  it.each(["quente ", "QUENTE", "quénte"])(
    "(4ii) classe com espaço/caixa/acento diferente (%j) NÃO casa o rótulo: sem 'always' recusa, sem gravar",
    async (cls) => {
      const { f, j1 } = await emVoo({
        classify: {
          config: declared([{ id: "b1", label: "quente" }]),
          edges: [
            { id: "e1", source: "task", target: "end", condition: br("b1") },
            { id: "e3", source: "task", target: "end", condition: br("no_reply") },
          ],
        },
      });
      await expect(journal.completeClassification(await f.scope(), j1, cls)).rejects.toMatchObject({
        code: "execution_edge_missing",
      });
      expect(await events(f.run, "ai_classified")).toHaveLength(0);
      expect((await attempts(f.run))[0].status).toBe("running");
    },
  );

  it("(4ii-b) com aresta 'always', classe fora do vocabulário vai ao padrão e grava a string CRUA", async () => {
    const { f, j1 } = await emVoo({
      classify: {
        config: declared([{ id: "b1", label: "quente" }]),
        edges: [
          { id: "e1", source: "task", target: "end2", condition: br("b1") },
          { id: "e3", source: "task", target: "end", condition: br("no_reply") },
          { id: "e4", source: "task", target: "end", priority: 0, condition: { type: "always" } },
        ],
        extraNodes: [END2],
      },
    });
    await journal.completeClassification(await f.scope(), j1, "QUENTE");
    expect((await attempts(f.run))[0].output_snapshot).toMatchObject({
      classification: "QUENTE",
      branch_id: "else",
    });
    expect((await f.scope()).current_node_id).toBe("end");
  });

  it.fails(
    "(4iii) ACHADO baixo: rótulo de um ramo igual ao ID de outro ramo anterior roteia para o ramo ERRADO",
    async () => {
      const { f, j1 } = await emVoo({
        classify: {
          config: declared([
            { id: "b2", label: "Z" },
            { id: "b1", label: "b2" },
          ]),
          edges: [
            { id: "e1", source: "task", target: "end", condition: br("b2") },
            { id: "e2", source: "task", target: "end2", condition: br("b1") },
            { id: "e3", source: "task", target: "end", condition: br("no_reply") },
          ],
          extraNodes: [END2],
        },
      });
      await journal.completeClassification(await f.scope(), j1, "b2");
      expect((await f.scope()).current_node_id).toBe("end2"); // correto: ramo b1 (rótulo 'b2')
    },
  );

  it("(4iv) rótulo 'no_reply' declarado pelo usuário captura o no_reply do motor (mesma regra do legado)", async () => {
    const { f } = await emVoo({
      classify: {
        config: declared([{ id: "u1", label: "no_reply" }]),
        edges: [
          { id: "e1", source: "task", target: "end2", condition: br("u1") },
          { id: "e3", source: "task", target: "end", condition: br("no_reply") },
        ],
        extraNodes: [END2],
      },
    });
    await novoLease(f.run);
    const h = await reentrada(f);
    await expect(
      journal.completeNoReply(await f.scope(), h, { next_node_id: "end" }),
    ).rejects.toThrow(/execution_edge_mismatch/);
    await expect(
      journal.completeNoReply(await f.scope(), h, { next_node_id: "end2" }),
    ).resolves.toEqual({ reused: false });
  });

  it("(4v) arestas duplicadas na mesma classe: empate de prioridade = a primeira declarada", async () => {
    const { f, j1 } = await emVoo({
      classify: {
        edges: [
          { id: "a", source: "task", target: "end", priority: 5, condition: cm("quente") },
          { id: "b", source: "task", target: "end2", priority: 5, condition: cm("quente") },
          { id: "c", source: "task", target: "end", priority: 5, condition: cm("no_reply") },
        ],
        extraNodes: [END2],
      },
    });
    await journal.completeClassification(await f.scope(), j1, "quente");
    expect((await events(f.run, "ai_classified"))[0]).toMatchObject({
      edge_id: "a",
      next_node_id: "end",
    });
  });

  it("(4vi) aresta removida do grafo pinado entre a decisão e a conclusão: recusa sem gravar, tentativa segue 'running'", async () => {
    const { f, j1 } = await emVoo();
    await pool.query(
      "update followup_flow_versions set graph = jsonb_set(graph,'{edges}',(select jsonb_agg(e) from jsonb_array_elements(graph->'edges') e where e->>'id' <> 'hot')) where id=$1",
      [f.version],
    );
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).rejects.toMatchObject({ code: "execution_edge_missing" });
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
    expect((await attempts(f.run))[0].status).toBe("running");
  });

  // (5)
  it("(5a) skipped pelo bridge: tentativa/passagem 'skipped', inscrição cancelada, 2º job tardio vira no-op", async () => {
    const { f, handle, j1 } = await emVoo();
    await novoLease(f.run);
    const again = await reentrada(f);
    const j2 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), again, j2);
    await turno(f, { kind: "skipped", reason: "opt_out" }, j1);
    const rows = await attempts(f.run);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: handle.attempt_id,
      status: "skipped",
      step_status: "skipped",
    });
    expect(await f.scope()).toMatchObject({
      status: "cancelled",
      cancel_reason: "opt_out",
      steps_taken: 1,
    });
    await turno(f, { kind: "skipped", reason: "opt_out" }, j2);
    await turno(f, { kind: "classified", class: "quente" }, j2);
    expect(await events(f.run, "turn_skipped")).toHaveLength(1);
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
    expect(await f.scope()).toMatchObject({ status: "cancelled", steps_taken: 1 });
  });

  it("(5b) deferred pelo bridge: tentativa continua aberta, steps_taken não sobe, o mesmo job ainda conclui", async () => {
    const { f, j1 } = await emVoo();
    const until = new Date(Date.now() + 3600_000);
    await turno(f, { kind: "deferred", until, reason: "janela" }, j1);
    expect(await events(f.run, "action_deferred")).toHaveLength(1);
    expect(await f.scope()).toMatchObject({ steps_taken: 0, current_node_id: "task" });
    expect((await attempts(f.run))[0].status).toBe("running");
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where id=$1",
      [f.run],
    );
    await turno(f, { kind: "classified", class: "quente" }, j1);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
  });

  it("(5b-replay) CORRIGIDO (era achado médio-baixo): o MESMO job adiado duas vezes é no-op (devolve reused, sem estourar a chave de idempotência)", async () => {
    const { f, j1 } = await emVoo();
    const until = new Date(Date.now() + 3600_000);
    await turno(f, { kind: "deferred", until, reason: "janela" }, j1);
    await turno(f, { kind: "deferred", until, reason: "janela" }, j1); // lança idx_followup_events_idem
    expect(await events(f.run, "action_deferred")).toHaveLength(1);
  });
  it("(5c) CORRIGIDO (era achado baixo): completeSkipped/deferSend (multi=true) em nó ACTION aceita 2º job órfão e cancela a inscrição", async () => {
    const f = await fixture({ decision: "action" });
    const handle = await f.begin();
    const a = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, a);
    const b = await mkJob(f.contact, own(f.run)); // 2º job do MESMO envio, nunca ligado
    await expect(journal.completeSkipped(await f.scope(), b, "opt_out")).rejects.toMatchObject({
      code: "execution_attempt_not_linked",
    });
  });

  // (6)
  it("(6) awaiting_reply no contrato 1: só o rastro (1 evento por job), sem fechar a tentativa; a classificação ainda conclui; tardio é descartado", async () => {
    const { f, j1 } = await emVoo();
    await turno(f, { kind: "awaiting_reply" }, j1);
    await turno(f, { kind: "awaiting_reply" }, j1);
    expect(await events(f.run, "classify_waiting")).toHaveLength(1);
    expect(await f.scope()).toMatchObject({ steps_taken: 0, current_node_id: "task" });
    const rows = await attempts(f.run);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where id=$1",
      [f.run],
    );
    await turno(f, { kind: "classified", class: "quente" }, j1);
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 1 });
    await turno(f, { kind: "awaiting_reply" }, j1);
    expect(await events(f.run, "classify_waiting")).toHaveLength(1);
  });

  it("(6b) awaiting_reply em nó que não é ai_classify (contrato 1) continua recusado", async () => {
    const f = await fixture({ decision: "action" });
    await f.begin();
    await expect(turno(f, { kind: "awaiting_reply" }, randomUUID())).rejects.toThrow(
      /não é 'ai_classify'/,
    );
  });

  // (8)
  it("(8) contato anonimizado: nada conclui nem é gravado; o vínculo guarda só ids", async () => {
    const { f, handle, j1 } = await emVoo();
    await pool.query(
      "update contacts set is_anonymized=true, anonymized_at=now() where organization_id=$1 and id=$2",
      [GOV_ORG, f.contact],
    );
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
    const { rows } = await pool.query(
      "select * from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "attempt_id",
      "created_at",
      "job_id",
      "organization_id",
    ]);
  });

  // ---- lacunas reveladas pelas sabotagens (C)
  it("(C-S03) job de OUTRA inscrição do mesmo fluxo/nó não conclui a classificação desta (isolamento por inscrição)", async () => {
    const a = await emVoo();
    const b = await emVoo();
    await expect(
      journal.completeClassification(await b.f.scope(), a.j1, "quente"),
    ).rejects.toMatchObject({ code: "execution_attempt_not_linked" });
    expect(await a.f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
    expect(await b.f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
    expect((await attempts(a.f.run))[0].status).toBe("running");
    expect((await attempts(b.f.run))[0].status).toBe("running");
    await expect(journal.completeSkipped(await b.f.scope(), a.j1, "opt_out")).rejects.toMatchObject(
      {
        code: "execution_attempt_not_linked",
      },
    );
  });

  it("(C-S08) completeNoReply repetido com o MESMO escopo velho é no-op (reused), não erro", async () => {
    const { f } = await emVoo();
    await novoLease(f.run);
    const h = await reentrada(f);
    const scope = await f.scope();
    await expect(journal.completeNoReply(scope, h, { next_node_id: "end" })).resolves.toEqual({
      reused: false,
    });
    await expect(journal.completeNoReply(scope, h, { next_node_id: "end" })).resolves.toEqual({
      reused: true,
    });
    expect(await events(f.run, "node_advanced")).toHaveLength(1);
  });

  it("(C-S24) nó com ramos declarados: no_reply do motor casa o ramo RESERVADO pelo id (não só pelo rótulo)", async () => {
    const { f } = await emVoo({
      classify: {
        config: declared([{ id: "hot", label: "quente" }]),
        edges: [
          { id: "e1", source: "task", target: "end", condition: br("hot") },
          { id: "e3", source: "task", target: "end2", condition: br("no_reply") },
        ],
        extraNodes: [END2],
      },
    });
    await novoLease(f.run);
    const h = await reentrada(f);
    await expect(
      journal.completeNoReply(await f.scope(), h, { next_node_id: "end2" }),
    ).resolves.toEqual({ reused: false });
    expect((await attempts(f.run))[0].output_snapshot).toMatchObject({
      branch_id: "no_reply",
      reason: "no_reply",
    });
  });

  it("(C-S05) tentativa que já não está 'running' (failed) não é concluída por job tardio", async () => {
    const { f, handle, j1 } = await emVoo();
    await pool.query(
      `update followup_execution_attempts set status='failed', completed_at=now(), error_snapshot='{"code":"x","message":"m","category":"transient","retryable":true}'::jsonb where organization_id=$1 and id=$2`,
      [GOV_ORG, handle.attempt_id],
    );
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente"),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 0 });
  });

  it("(C-S23) o claim do job é conferido na transação da classificação: claim de outro worker não conclui", async () => {
    const { f, j1 } = await emVoo();
    const lockedAt = new Date().toISOString();
    await pool.query(
      "update job_queue set status='running', locked_by='w-bom', locked_at=$3 where organization_id=$1 and id=$2",
      [GOV_ORG, j1, lockedAt],
    );
    await pool.query(
      `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
       values($1,$2,'task','classify_enqueued','{}'::jsonb,'task:0')`,
      [GOV_ORG, f.run],
    );
    await pool.query(
      "update followup_enrollments set steps_taken=1 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente", {
        worker_id: "w-ruim",
        acquired_at: lockedAt,
      }),
    ).rejects.toThrow(/followup_job_stale|PT409/);
    expect(await events(f.run, "ai_classified")).toHaveLength(0);
    expect((await attempts(f.run))[0].status).toBe("running");
    await expect(
      journal.completeClassification(await f.scope(), j1, "quente", {
        worker_id: "w-bom",
        acquired_at: lockedAt,
      }),
    ).resolves.toMatchObject({ reused: false });
    expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 2 });
  });
});
