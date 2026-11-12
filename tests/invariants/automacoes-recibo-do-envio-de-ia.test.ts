import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import { resultadoDoEnvioDoFollowup } from "@/lib/agent-engine/edge/crm/send-ledger";
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

describe("recibo do envio de IA: a fronteira entre o ledger e o diário — Postgres real", () => {
  // Envio enfileirado pelo PRÓPRIO motor (tentativa aberta, evento de origem e job ligado), com o job
  // "running" e o claim do worker: é o que o banco exige para aceitar a conclusão.
  async function envioEnfileirado() {
    const f = await fixture({ decision: "action" });
    let jobId = "";
    await avancarEnrollmentAtivo(
      {
        db: adapter,
        clock: () => new Date(),
        enqueueJob: async (job: {
          organization_id: string;
          contact_id: string;
          payload: object;
        }) => {
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
      "update job_queue set status='running',locked_by='w-ia',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
      [GOV_ORG, jobId],
    );
    const claim = { worker_id: "w-ia", acquired_at: locked.rows[0].locked_at as string };
    const linha = (seq: number, status: string, message: string | null) =>
      pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,$4,'hash',$5,$6)`,
        [GOV_ORG, f.contact, jobId, seq, status, message],
      );
    return { f, jobId, claim, linha };
  }

  it("turno de IA com várias mensagens aceitas: o worker diz 'sent' e o diário conclui com TODAS, na ordem", async () => {
    const { f, jobId, claim, linha } = await envioEnfileirado();
    const m1 = randomUUID();
    const m2 = randomUUID();
    await linha(1, "accepted", m1);
    await linha(2, "accepted", m2);
    await expect(resultadoDoEnvioDoFollowup(pool, GOV_ORG, jobId)).resolves.toEqual({
      kind: "sent",
    });
    const out = await journal.completeSend(await f.scope(), jobId, claim);
    expect(out.reused).toBe(false);
    expect(out.output?.messages.map((m) => m.message_id)).toEqual([m1, m2]);
    const eff = await pool.query(
      "select external_ref,status from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
      [GOV_ORG, f.run],
    );
    expect(eff.rows).toEqual([{ external_ref: m1, status: "confirmed" }]);
    expect(await f.scope()).toMatchObject({ current_node_id: "end" });
  });

  it("mensagem retida (queued) ao lado de uma aceita: o worker NÃO conclui (lança), então o diário nunca recebe recibo parcial", async () => {
    const { linha, jobId } = await envioEnfileirado();
    await linha(1, "accepted", randomUUID());
    await linha(2, "queued", randomUUID());
    await expect(resultadoDoEnvioDoFollowup(pool, GOV_ORG, jobId)).rejects.toThrow(
      "followup_message_not_sent",
    );
  });

  it("o assistente não enviou nada: 'skipped' (nunca 'sent'), e o diário o fecha como skipped sem recibo", async () => {
    const { f, jobId, claim } = await envioEnfileirado();
    const r = await resultadoDoEnvioDoFollowup(pool, GOV_ORG, jobId);
    expect(r.kind).toBe("skipped");
    await expect(journal.completeSend(await f.scope(), jobId, claim)).rejects.toMatchObject({
      code: "execution_send_receipt_missing", // sem recibo aceito não há sucesso
    });
    await expect(
      journal.completeSkipped(await f.scope(), jobId, "sem_envio", claim),
    ).resolves.toEqual({ reused: false });
    expect(await f.scope()).toMatchObject({ status: "cancelled" });
  });

  it("todas as mensagens vetadas: 'skipped' com o motivo das regras, e o diário o fecha", async () => {
    const { f, jobId, claim, linha } = await envioEnfileirado();
    await linha(1, "vetoed", null);
    await expect(resultadoDoEnvioDoFollowup(pool, GOV_ORG, jobId)).resolves.toEqual({
      kind: "skipped",
      reason: "O envio foi recusado pelas regras do atendimento.",
    });
    await journal.completeSkipped(await f.scope(), jobId, "vetado", claim);
    expect(await f.scope()).toMatchObject({ status: "cancelled", cancel_reason: "vetado" });
  });

  it("o recibo do diário conta SÓ mensagens aceitas e com id: uma retida ao lado, ou uma aceita sem id, não entram", async () => {
    const { f, jobId, claim, linha } = await envioEnfileirado();
    const aceita = randomUUID();
    await linha(1, "accepted", aceita);
    await linha(2, "queued", randomUUID()); // retida: não é recibo
    await linha(3, "accepted", null); // aceita mas sem id do CRM: não é recibo utilizável
    // O worker nunca chamaria isto com uma linha retida (resultadoDoEnvioDoFollowup lança antes);
    // aqui se mede a guarda do PRÓPRIO diário, que não pode confiar no chamador.
    const out = await journal.completeSend(await f.scope(), jobId, claim);
    expect(out.output?.messages.map((m) => m.message_id)).toEqual([aceita]);
  });
});
