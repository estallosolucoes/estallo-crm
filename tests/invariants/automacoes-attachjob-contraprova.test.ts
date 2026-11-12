import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
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

describe("attachJob — contraprova em Postgres real", () => {
  const own = (run: string, steps = 0) => ({
    followup_enrollment_id: run,
    node_id: "task",
    source_step_key: `task:${steps}`,
  });
  const mkJob = async (
    contact: string,
    payload: Record<string, unknown>,
    kind = "followup_turn",
  ) => {
    const id = randomUUID();
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,$4,$5)",
      [id, GOV_ORG, contact, kind, payload],
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

  it("job de outro contato com payload idêntico é recusado", async () => {
    const f = await fixture();
    const handle = await f.begin();
    const outro = randomUUID();
    await pool.query(
      "insert into contacts(id,organization_id,display_name) values($1,$2,'Outro')",
      [outro, GOV_ORG],
    );
    const job = await mkJob(outro, own(f.run));
    await expect(journal.attachJob(await f.scope(), handle, job)).rejects.toMatchObject({
      code: "execution_job_not_found",
    });
    expect(await linked(handle.attempt_id)).toBeNull();
  });

  it("corrida attachJob × fail: serializa; ou liga e depois falha, ou recusa por estado velho", async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture();
      const handle = await f.begin();
      const scope = await f.scope();
      const job = await mkJob(f.contact, own(f.run));
      const [attach, failed] = await Promise.allSettled([
        journal.attachJob(scope, handle, job),
        journal.fail(scope, handle, {
          code: "synthetic_failure",
          message: "Falha sintética.",
          category: "transient",
          retryable: true,
        }),
      ]);
      const status = (
        await pool.query(
          "select status from followup_execution_attempts where organization_id=$1 and id=$2",
          [GOV_ORG, handle.attempt_id],
        )
      ).rows[0].status;
      // Nenhuma das duas pode explodir com erro que não seja a recusa por estado velho.
      for (const r of [attach, failed])
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(StaleServiceBoundaryError);
      expect(failed.status === "fulfilled" || status === "failed").toBe(true);
      // Se o vínculo foi gravado, o job é exatamente o pedido; senão continua nulo.
      const linkedJob = await linked(handle.attempt_id);
      expect(attach.status === "fulfilled" ? linkedJob : null).toBe(
        attach.status === "fulfilled" ? job : null,
      );
      if (attach.status === "rejected") expect(linkedJob).toBeNull();
    }
  });

  it("motor: nó de envio abre a tentativa, enfileira e liga o job — uma vez, no mesmo passo", async () => {
    const f = await fixture({ decision: "action" });
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
    await avancarEnrollmentAtivo(deps, await f.scope());
    expect(jobs).toHaveLength(1);
    const rows = await pool.query(
      `select a.status,a.job_id from followup_execution_attempts a
       join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
       where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, f.run],
    );
    expect(rows.rows).toEqual([{ status: "running", job_id: jobs[0] }]);
    // Mesmo tick repetido (recheck): não abre outra tentativa nem enfileira outro job.
    await avancarEnrollmentAtivo(deps, await f.scope());
    expect(jobs).toHaveLength(1);
    const after = await pool.query(
      `select count(*)::int n from followup_execution_attempts a
       join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
       where s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, f.run],
    );
    expect(after.rows[0].n).toBe(1);
  });

  describe("relógio do banco: o próximo passo nunca é agendado à frente do now() do Postgres", () => {
    // Medido na issue da 0147: o relógio do processo anda 17–34 ms à frente do banco; o claim
    // compara com now() do banco e o item ficaria invisível até o tick seguinte (até 60 s).
    const aFrenteDoBanco = async (run: string) =>
      (
        await pool.query(
          "select next_eval_at > clock_timestamp() as a_frente from followup_enrollments where organization_id=$1 and id=$2",
          [GOV_ORG, run],
        )
      ).rows[0].a_frente as boolean;

    it("tarefa, e conclusão de envio, avançam 'agora' pelo relógio do banco (8 repetições)", async () => {
      for (let i = 0; i < 8; i++) {
        const t = await fixture();
        await journal.completeTask(await t.scope(), await t.begin());
        expect(await aFrenteDoBanco(t.run), `tarefa, rodada ${i}`).toBe(false);

        const s = await fixture({ decision: "action" });
        const handle = await s.begin();
        const job = await mkJob(s.contact, own(s.run));
        await journal.attachJob(await s.scope(), handle, job);
        await pool.query(
          `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
           values($1,$2,$3,1,'hash','accepted',$4)`,
          [GOV_ORG, s.contact, job, randomUUID()],
        );
        await journal.completeSend(await s.scope(), job);
        expect(await aFrenteDoBanco(s.run), `envio, rodada ${i}`).toBe(false);
      }
    });
  });

  it("espera vencida NO BANCO avança mesmo com o relógio do processo atrasado (VPS com relógio defasado)", async () => {
    const f = await fixture({ decision: "wait" });
    const atrasado = {
      db: adapter,
      clock: () => new Date(Date.now() - 60_000),
      enqueueJob: async () => {},
    };
    await avancarEnrollmentAtivo(atrasado, await f.scope()); // estaciona a espera (5 min no futuro do relógio atrasado)
    expect(await f.scope()).toMatchObject({ current_node_id: "task", status: "active" });
    // O claim já avaliou a espera contra o now() do banco: a inscrição vence e é reclamada.
    await pool.query(
      `update followup_execution_attempts set next_eval_at=now()-interval '1 second'
       where organization_id=$1 and status='waiting' and step_id in
        (select id from followup_execution_steps where organization_id=$1 and enrollment_id=$2)`,
      [GOV_ORG, f.run],
    );
    await pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second',claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    await avancarEnrollmentAtivo(atrasado, await f.scope());
    expect(await f.scope()).toMatchObject({ current_node_id: "end" });
  });

  describe("conclusão do envio com recibo do ledger", () => {
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
        "update job_queue set status='running',locked_by='w-test',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
        [GOV_ORG, jobId],
      );
      const claim = { worker_id: "w-test", acquired_at: locked.rows[0].locked_at as string };
      const ledger = (status: string, message: string | null) =>
        pool.query(
          `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
           values($1,$2,$3,1,'hash',$4,$5)`,
          [GOV_ORG, f.contact, jobId, status, message],
        );
      return { f, jobId, claim, ledger };
    }

    it("recibo aceito: efeito, output, passagem e avanço numa transação; repetir não duplica", async () => {
      const { f, jobId, claim, ledger } = await envioEnfileirado();
      const message = randomUUID();
      await ledger("accepted", message);
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
      // o tick de enfileiramento sobe steps_taken para 1; a conclusão sobe para 2 (como no legado)
      expect(await f.scope()).toMatchObject({ current_node_id: "end", steps_taken: 2 });
      const att = await pool.query(
        `select a.status,a.output_snapshot,s.status as step_status from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and a.job_id=$2`,
        [GOV_ORG, jobId],
      );
      expect(att.rows).toHaveLength(1);
      expect(att.rows[0]).toMatchObject({ status: "succeeded", step_status: "succeeded" });
      expect(att.rows[0].output_snapshot.messages).toEqual([
        { message_id: message, accepted_at: expect.any(String) },
      ]);
      const eff = await pool.query(
        "select status,external_ref,operation from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(eff.rows).toEqual([
        { status: "confirmed", external_ref: message, operation: "send_message" },
      ]);
      const ev = await pool.query(
        "select count(*)::int n from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'",
        [f.run],
      );
      expect(ev.rows[0].n).toBe(1);
      // Repetição direta no diário (perda de ACK): devolve o mesmo recibo, nada novo.
      const again = await journal.completeSend(await f.scope(), jobId);
      expect(again).toMatchObject({ reused: true });
      const after = await pool.query(
        "select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(after.rows[0].n).toBe(1);
    });

    it("worker que perdeu o lease do job é recusado DENTRO da transação: nada é gravado", async () => {
      const { f, jobId, claim, ledger } = await envioEnfileirado();
      await ledger("accepted", randomUUID());
      const antigo = { worker_id: "w-que-perdeu", acquired_at: claim.acquired_at };
      await expect(journal.completeSend(await f.scope(), jobId, antigo)).rejects.toBeDefined();
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
      const eff = await pool.query(
        "select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(eff.rows[0].n).toBe(0);
      const att = await pool.query(
        "select status from followup_execution_attempts where organization_id=$1 and job_id=$2",
        [GOV_ORG, jobId],
      );
      expect(att.rows).toEqual([{ status: "running" }]);
      // Com o claim certo, a mesma conclusão passa.
      await expect(journal.completeSend(await f.scope(), jobId, claim)).resolves.toMatchObject({
        reused: false,
      });
    });

    it("repetir depois do expurgo do snapshot devolve reused sem output, não quebra", async () => {
      const { f, jobId, claim, ledger } = await envioEnfileirado();
      await ledger("accepted", randomUUID());
      await journal.completeSend(await f.scope(), jobId, claim);
      await pool.query(
        `update followup_execution_attempts set output_snapshot=null,payload_expired_at=now()
         where organization_id=$1 and job_id=$2`,
        [GOV_ORG, jobId],
      );
      await expect(journal.completeSend(await f.scope(), jobId, claim)).resolves.toEqual({
        output: null,
        reused: true,
      });
    });

    it("sem recibo ACEITO no ledger (queued) não há sucesso: nada avança nem vira efeito", async () => {
      const { f, jobId, claim, ledger } = await envioEnfileirado();
      await ledger("queued", randomUUID());
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
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
      const eff = await pool.query(
        "select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(eff.rows[0].n).toBe(0);
      const att = await pool.query(
        "select status from followup_execution_attempts where organization_id=$1 and job_id=$2",
        [GOV_ORG, jobId],
      );
      expect(att.rows).toEqual([{ status: "running" }]);
    });

    it("vínculo que nunca aconteceu: completeSend acha a tentativa pelo payload do job e conclui", async () => {
      const f = await fixture({ decision: "action" });
      const handle = await f.begin(); // tentativa aberta; o attachJob "falhou" e não houve vínculo
      const jobId = await mkJob(f.contact, own(f.run));
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, f.contact, jobId, randomUUID()],
      );
      expect(await linked(handle.attempt_id)).toBeNull();
      await expect(journal.completeSend(await f.scope(), jobId)).resolves.toMatchObject({
        reused: false,
      });
      expect(await linked(handle.attempt_id)).toBe(jobId);
      expect(await f.scope()).toMatchObject({ current_node_id: "end" });
    });

    it("o religamento pelo payload recusa job órfão de visita anterior (nascido antes da tentativa atual)", async () => {
      const f = await fixture({ decision: "action" });
      const antigo = await mkJob(f.contact, own(f.run)); // J1: visita anterior, nunca ligado
      await pool.query("select pg_sleep(0.05)");
      const handle = await f.begin(); // tentativa atual começa DEPOIS de J1
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, f.contact, antigo, randomUUID()],
      );
      await expect(journal.completeSend(await f.scope(), antigo)).rejects.toMatchObject({
        code: "execution_attempt_not_linked",
      });
      expect(await linked(handle.attempt_id)).toBeNull();
      expect(await f.scope()).toMatchObject({ current_node_id: "task" });
      // O job da tentativa atual (criado depois do begin) continua ligável.
      const atual = await mkJob(f.contact, own(f.run));
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, f.contact, atual, randomUUID()],
      );
      await expect(journal.completeSend(await f.scope(), atual)).resolves.toMatchObject({
        reused: false,
      });
      expect(await linked(handle.attempt_id)).toBe(atual);
    });

    it("o religamento pelo payload não aceita job de outra inscrição nem de outro contato", async () => {
      const f = await fixture({ decision: "action" });
      const handle = await f.begin();
      const outro = randomUUID();
      await pool.query(
        "insert into contacts(id,organization_id,display_name) values($1,$2,'Outro')",
        [outro, GOV_ORG],
      );
      const alheio = await mkJob(f.contact, {
        ...own(f.run),
        followup_enrollment_id: randomUUID(),
      });
      const deOutroContato = await mkJob(outro, own(f.run));
      for (const j of [alheio, deOutroContato]) {
        await expect(journal.completeSend(await f.scope(), j)).rejects.toMatchObject({
          code: "execution_attempt_not_linked",
        });
      }
      expect(await linked(handle.attempt_id)).toBeNull();
    });

    it("turno PULADO: tentativa e passagem fecham como skipped e a inscrição é cancelada, numa transação", async () => {
      const { f, jobId, claim } = await envioEnfileirado();
      await expect(
        journal.completeSkipped(await f.scope(), jobId, "opt_out", claim),
      ).resolves.toEqual({ reused: false });
      expect(await f.scope()).toMatchObject({ status: "cancelled", cancel_reason: "opt_out" });
      const r = await pool.query(
        `select a.status,s.status as step_status from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and a.job_id=$2`,
        [GOV_ORG, jobId],
      );
      expect(r.rows).toEqual([{ status: "skipped", step_status: "skipped" }]);
      const ev = await pool.query(
        "select payload from followup_enrollment_events where enrollment_id=$1 and event_type='turn_skipped'",
        [f.run],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].payload).toMatchObject({ reason: "opt_out" });
      // Nenhum recibo de efeito: pular não envia nada.
      const eff = await pool.query(
        "select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(eff.rows[0].n).toBe(0);
      // Repetir (retry do job) é no-op.
      await expect(
        journal.completeSkipped(await f.scope(), jobId, "opt_out", claim),
      ).resolves.toEqual({ reused: true });
    });

    it("envio ADIADO: só o adiamento é gravado, a tentativa segue aberta e o mesmo job ainda a conclui", async () => {
      const { f, jobId, claim, ledger } = await envioEnfileirado();
      const antes = await f.scope();
      const until = new Date(Date.now() + 3 * 3600_000);
      await journal.deferSend(await f.scope(), jobId, until, until, "janela_de_disparo", claim);
      const depois = await f.scope();
      expect(depois.steps_taken).toBe(antes.steps_taken); // o passo segue devendo a conclusão
      expect(depois.current_node_id).toBe("task");
      expect(new Date(depois.next_eval_at!).getTime()).toBe(until.getTime());
      const att = await pool.query(
        "select status from followup_execution_attempts where organization_id=$1 and job_id=$2",
        [GOV_ORG, jobId],
      );
      expect(att.rows).toEqual([{ status: "running" }]);
      const ev = await pool.query(
        "select payload from followup_enrollment_events where enrollment_id=$1 and event_type='action_deferred'",
        [f.run],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].payload).toMatchObject({ reason: "janela_de_disparo" });
      // Quando o envio finalmente sai, o MESMO job conclui a mesma tentativa.
      await ledger("accepted", randomUUID());
      await expect(journal.completeSend(await f.scope(), jobId, claim)).resolves.toMatchObject({
        reused: false,
      });
      expect(await f.scope()).toMatchObject({ current_node_id: "end" });
    });

    it("pular ou adiar um job que nenhuma tentativa conhece é recusado, sem gravar nada", async () => {
      const { f } = await envioEnfileirado();
      const estranho = randomUUID();
      await expect(journal.completeSkipped(await f.scope(), estranho, "x")).rejects.toMatchObject({
        code: "execution_attempt_not_linked",
      });
      await expect(
        journal.deferSend(await f.scope(), estranho, new Date(), new Date(), "x"),
      ).rejects.toMatchObject({ code: "execution_attempt_not_linked" });
      expect(await f.scope()).toMatchObject({ status: "active", current_node_id: "task" });
    });

    it("job que nenhuma tentativa conhece é recusado", async () => {
      const { f } = await envioEnfileirado();
      await expect(journal.completeSend(await f.scope(), randomUUID())).rejects.toMatchObject({
        code: "execution_attempt_not_linked",
      });
    });
  });

  it("tentativa em 'waiting' (nó wait estacionado e retomado) aceita o vínculo", async () => {
    const f = await fixture({ decision: "wait" });
    const first = await f.begin();
    await journal.parkWait(await f.scope(), first, {
      kind: "wait",
      next_eval_at: new Date(Date.now() + 300000),
    });
    const st = await pool.query(
      "select status from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, first.attempt_id],
    );
    expect(st.rows[0].status).toBe("waiting");
    // retomada: novo lease; a tentativa segue 'waiting' com o handle novo
    await pool.query(
      "update followup_enrollments set claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    const scope = await f.scope();
    const resumed = await journal.begin(scope, {});
    if (resumed.kind !== "ready") throw new Error("expected_ready");
    expect(resumed.handle.attempt_id).toBe(first.attempt_id);
    const job = await mkJob(f.contact, own(f.run, 1));
    await expect(journal.attachJob(scope, resumed.handle, job)).resolves.toEqual({ reused: false });
    expect(await linked(first.attempt_id)).toBe(job);
  });

  it("handle antigo (revisão anterior ao estacionamento) é recusado e não liga", async () => {
    const f = await fixture({ decision: "wait" });
    const first = await f.begin();
    await journal.parkWait(await f.scope(), first, {
      kind: "wait",
      next_eval_at: new Date(Date.now() + 300000),
    });
    const job = await mkJob(f.contact, own(f.run));
    await expect(journal.attachJob(await f.scope(), first, job)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(await linked(first.attempt_id)).toBeNull();
  });

  it("lease expirado recusa o vínculo", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope),
      job = await mkJob(f.contact, own(f.run));
    await pool.query(
      "update followup_enrollments set claimed_until=now()-interval '1 second' where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    await expect(journal.attachJob(scope, handle, job)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(await linked(handle.attempt_id)).toBeNull();
  });

  it.each(["paused_manual", "cancelled"])("inscrição %s recusa o vínculo", async (status) => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope),
      job = await mkJob(f.contact, own(f.run));
    await pool.query(
      "update followup_enrollments set status=$3 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run, status],
    );
    await expect(journal.attachJob(scope, handle, job)).rejects.toBeInstanceOf(
      StaleServiceBoundaryError,
    );
    expect(await linked(handle.attempt_id)).toBeNull();
  });

  it("dois attachJob simultâneos com jobs diferentes: um vence, o outro recebe conflito", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope);
    const jobs = [await mkJob(f.contact, own(f.run)), await mkJob(f.contact, own(f.run))];
    const out = await Promise.allSettled(jobs.map((j) => journal.attachJob(scope, handle, j)));
    const won = out.flatMap((r, i) => (r.status === "fulfilled" ? [i] : []));
    expect(won).toHaveLength(1);
    const lost = out[1 - won[0]!] as PromiseRejectedResult;
    expect(lost.status).toBe("rejected");
    expect(lost.reason).toMatchObject({ code: "execution_job_conflict" });
    expect(await linked(handle.attempt_id)).toBe(jobs[won[0]!]);
  });

  it("job do mesmo contato e payload, mas de outro kind, não é aceito", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope),
      wrongKind = await mkJob(f.contact, own(f.run), "inbound_turn");
    await expect(journal.attachJob(scope, handle, wrongKind)).rejects.toMatchObject({
      code: "execution_job_not_found",
    });
    expect(await linked(handle.attempt_id)).toBeNull();
  });

  it("job de outra inscrição (mesmo contato) não é aceito", async () => {
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope),
      alheio = await mkJob(f.contact, {
        followup_enrollment_id: randomUUID(),
        node_id: "task",
        source_step_key: "task:0",
      });
    await expect(journal.attachJob(scope, handle, alheio)).rejects.toMatchObject({
      code: "execution_job_not_found",
    });
    expect(await linked(handle.attempt_id)).toBeNull();
  });

  it("job apagado da fila zera job_id (FK set null) e o anti-reaponte deixa de valer: novo job passa", async () => {
    // Comportamento documentado, não garantia desejada: a trava "não reaponta"
    // depende de job_id não-nulo; após o expurgo da fila a tentativa pode ser religada.
    const f = await fixture(),
      scope = await f.scope(),
      handle = await f.begin(scope),
      first = await mkJob(f.contact, own(f.run)),
      second = await mkJob(f.contact, own(f.run));
    await journal.attachJob(scope, handle, first);
    await pool.query("delete from job_queue where organization_id=$1 and id=$2", [GOV_ORG, first]);
    expect(await linked(handle.attempt_id)).toBeNull();
    await expect(journal.attachJob(scope, handle, second)).resolves.toEqual({ reused: false });
    expect(await linked(handle.attempt_id)).toBe(second);
  });
});
