import { readFileSync } from "node:fs";
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

describe("0706: religamento multi-job só para a classificação, e o backfill do vínculo", () => {
  const own = (run: string) => ({
    followup_enrollment_id: run,
    node_id: "task",
    source_step_key: "task:0",
  });
  const mkJob = async (contact: string, payload: Record<string, unknown>) => {
    const id = randomUUID();
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
      [id, GOV_ORG, contact, payload],
    );
    return id;
  };

  it("ENVIO: um 2º job órfão (nunca ligado) NÃO é religado por completeSkipped/deferSend a uma tentativa que já tem outro job", async () => {
    const f = await fixture({ decision: "action" });
    const handle = await f.begin();
    const j1 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, j1); // a tentativa do envio já tem seu job
    const j2 = await mkJob(f.contact, own(f.run)); // órfão: o enfileiramento não o ligou
    // O attachJob recusa um 2º job no envio; os caminhos de skipped/deferred não podem escapar disso.
    await expect(journal.completeSkipped(await f.scope(), j2, "opt_out")).rejects.toMatchObject({
      code: "execution_attempt_not_linked",
    });
    await expect(
      journal.deferSend(await f.scope(), j2, new Date(), new Date(), "janela"),
    ).rejects.toMatchObject({ code: "execution_attempt_not_linked" });
    // Nada foi cancelado nem religado: o envio do 1º job segue a caminho.
    expect(await f.scope()).toMatchObject({ status: "active", current_node_id: "task" });
    const att = await pool.query(
      "select status,job_id from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(att.rows).toEqual([{ status: "running", job_id: j1 }]);
    const ligados = await pool.query(
      "select count(*)::int n from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(ligados.rows[0].n).toBe(1);
  });

  it("CLASSIFICAÇÃO: o mesmo caso (2º job órfão) continua religando, porque lá vários jobs são legítimos", async () => {
    const f = await fixture({ decision: "ai_classify" });
    const handle = await f.begin();
    const j1 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, j1);
    const j2 = await mkJob(f.contact, own(f.run));
    await expect(journal.completeSkipped(await f.scope(), j2, "opt_out")).resolves.toEqual({
      reused: false,
    });
    expect(await f.scope()).toMatchObject({ status: "cancelled", cancel_reason: "opt_out" });
  });

  it("janela de reaproveitamento: dentro dela a tentativa da classificação é reaproveitada; passada a janela, cai no caminho de lease interrompido (conta no orçamento)", async () => {
    const f = await fixture({ decision: "ai_classify" });
    const input = { contact_id: f.contact, lead_id: f.lead, purpose: "classify" };
    const handle = await f.begin();
    const novoLease = () =>
      pool.query(
        "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
        [GOV_ORG, f.run],
      );
    // Dentro da janela (tentativa recém-aberta): reaproveita, mesma tentativa, attempt_no 1.
    await novoLease();
    const dentro = await journal.begin(await f.scope(), input);
    expect(dentro).toMatchObject({ kind: "ready" });
    if (dentro.kind !== "ready") throw new Error("expected_ready");
    expect(dentro.handle.attempt_id).toBe(handle.attempt_id);
    expect(dentro.handle.attempt_no).toBe(1);
    // Passada a janela (24 h ou o dobro da carência, o maior): NÃO reaproveita. Um worker que morre
    // sempre no mesmo ponto passa a consumir o orçamento e termina em aviso, em vez de reentrar sem fim.
    await pool.query(
      "update followup_execution_attempts set started_at=now()-interval '10 days' where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    await novoLease();
    const fora = await journal.begin(await f.scope(), input);
    if (fora.kind !== "ready") throw new Error("expected_ready");
    expect(fora.handle.attempt_id).not.toBe(handle.attempt_id);
    expect(fora.handle.attempt_no).toBe(2);
    const velha = await pool.query(
      "select status from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(velha.rows[0].status).toBe("failed");
  });

  describe("bordas da janela de reaproveitamento (reuseWindowMs = max(24 h, 2 × carência))", () => {
    const HORA = 3_600_000;
    /** Carência do nó (grafo pinado), idade da tentativa e quantas horas atrás ela começou. */
    async function begunComIdade(graceMs: number, horasAtras: number) {
      const f = await fixture({ decision: "ai_classify" });
      await pool.query(
        `update followup_flow_versions set graph=jsonb_set(graph,'{nodes,0,config,grace_timeout_ms}',$2::jsonb)
         where organization_id=$1 and id=(select version_id from followup_enrollments where organization_id=$1 and id=$3)`,
        [GOV_ORG, String(graceMs), f.run],
      );
      const handle = await f.begin();
      await pool.query(
        "update followup_execution_attempts set started_at=now()-($3::double precision * interval '1 hour') where organization_id=$1 and id=$2",
        [GOV_ORG, handle.attempt_id, horasAtras],
      );
      await pool.query(
        "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
        [GOV_ORG, f.run],
      );
      const again = await journal.begin(await f.scope(), {
        contact_id: f.contact,
        lead_id: f.lead,
        purpose: "classify",
      });
      if (again.kind !== "ready") throw new Error("expected_ready");
      return { reaproveitou: again.handle.attempt_id === handle.attempt_id, again };
    }

    it("carência de 3 dias: uma tentativa de 50 h AINDA é reaproveitada (a janela acompanha 2× a carência)", async () => {
      expect((await begunComIdade(72 * HORA, 50)).reaproveitou).toBe(true);
    });

    it("carência curta: 23 h reaproveita e 25 h NÃO (o piso é 24 h)", async () => {
      expect((await begunComIdade(900_000, 23)).reaproveitou).toBe(true);
      const fora = await begunComIdade(900_000, 25);
      expect(fora.reaproveitou).toBe(false);
      expect(fora.again.handle.attempt_no).toBe(2); // caminho de lease interrompido: conta no orçamento
    });
  });

  it("deferSend na classificação religa um 2º job órfão (o espelho do completeSkipped); no envio é recusado", async () => {
    const f = await fixture({ decision: "ai_classify" });
    const handle = await f.begin();
    const j1 = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, j1);
    const j2 = await mkJob(f.contact, own(f.run)); // órfão
    const quando = new Date(Date.now() + 3600_000);
    await expect(journal.deferSend(await f.scope(), j2, quando, quando, "janela")).resolves.toEqual(
      { reused: false },
    );
    const ligados = await pool.query(
      "select count(*)::int n from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(ligados.rows[0].n).toBe(2);
  });

  it("deferSend repetido para o MESMO job devolve { reused: true } (retry depois do commit é no-op)", async () => {
    const f = await fixture({ decision: "action" });
    const handle = await f.begin();
    const job = await mkJob(f.contact, own(f.run));
    await journal.attachJob(await f.scope(), handle, job);
    const quando = new Date(Date.now() + 3600_000);
    await expect(
      journal.deferSend(await f.scope(), job, quando, quando, "janela"),
    ).resolves.toEqual({ reused: false });
    await expect(
      journal.deferSend(await f.scope(), job, quando, quando, "janela"),
    ).resolves.toEqual({ reused: true });
    const ev = await pool.query(
      "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='action_deferred'",
      [f.run],
    );
    expect(ev.rows[0].n).toBe(1);
  });

  it("backfill da 0706: vínculo da 0705 (job_id na tentativa) vira linha na tabela nova, uma vez, sem duplicar", async () => {
    const f = await fixture({ decision: "action" });
    const handle = await f.begin();
    const job = await mkJob(f.contact, own(f.run));
    // Estado ANTERIOR à 0706: o job está só em attempts.job_id, e a tabela nova não tem a linha.
    await pool.query(
      "update followup_execution_attempts set job_id=$3 where organization_id=$1 and id=$2",
      [GOV_ORG, handle.attempt_id, job],
    );
    const antes = await pool.query(
      "select count(*)::int n from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(antes.rows[0].n).toBe(0);
    // O SQL REAL do backfill, extraído da migration (não uma cópia que pudesse divergir).
    const migration = readFileSync(
      "supabase/migrations/20261021140000_0706_execucoes_varios_jobs_por_tentativa.sql",
      "utf8",
    );
    const backfill =
      /insert into public\.followup_execution_attempt_jobs[\s\S]*?on conflict do nothing;/.exec(
        migration,
      )![0];
    await pool.query(backfill);
    await pool.query(backfill); // reaplicar (update.sh) não duplica
    const depois = await pool.query(
      "select job_id from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, handle.attempt_id],
    );
    expect(depois.rows).toEqual([{ job_id: job }]);
  });
});
