import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";

import {
  aplicarRespostaInbound,
  avancarEnrollmentAtivo,
  createSupabaseAdminClient,
} from "@/lib/followup/engine";
import { PgExecutionJournal } from "@/lib/followup/execution-journal-pg";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
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
import { GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 6,
});
const adapter = createPgAdminClient(pool);
// TESTE_ADAPTADOR_REST=1: o motor (tick) fala com o PostgREST real do Supabase local, como em produção;
// o worker (turn-bridge) e a leitura de escopo seguem em `pg`, que é também o que o worker usa lá.
// Um cliente por tick, como o cron: o mapa de revisões (CAS) é do cliente e o claim o repõe a cada tick.
const motorDb = () =>
  process.env.TESTE_ADAPTADOR_REST === "1"
    ? createSupabaseAdminClient(
        createClient(process.env.REST_URL!, process.env.REST_SERVICE_KEY!, {
          auth: { persistSession: false },
        }),
      )
    : adapter;
const journal = new PgExecutionJournal(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const deps = {
  db: adapter,
  clock: () => new Date(),
  enqueueJob: async () => {
    throw new Error("match_reply_must_not_enqueue");
  },
};

type SaveTo = { kind: "contact_name" } | { kind: "contact_custom" | "lead_custom"; key: string };

async function fixture(
  options: {
    saveTo?: SaveTo;
    ifExists?: "overwrite" | "skip" | "confirm";
    withLead?: boolean;
    contactName?: string | null;
  } = {},
) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,$3,'Ana')",
    [contact, GOV_ORG, options.contactName === undefined ? "Ana" : options.contactName],
  );
  let lead: string | null = null;
  let leadNovo: string | null = null;
  if (options.withLead !== undefined) {
    // Dois negócios do mesmo contato: o EXPLÍCITO da inscrição e um mais recente, que o caminho
    // legado escolheria ("Lead mais recente") e o contrato nunca pode tocar.
    lead = randomUUID();
    leadNovo = randomUUID();
    await pool.query(
      `insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,updated_at)
       values($1,$3,$4,$5,$6,'Explícito',now()-interval '1 day'),($2,$3,$4,$5,$6,'Mais recente',now())`,
      [lead, leadNovo, GOV_ORG, contact, GOV_PIPELINE, GOV_STAGE],
    );
  }
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const graph = {
    execution_contract: 1,
    nodes: [
      {
        id: "task",
        type: "match_reply",
        label: "Pergunta",
        position: { x: 0, y: 0 },
        config: {
          branches: [{ id: "b_sim", label: "Sim", op: "eq", pattern: "sim" }],
          grace_timeout_ms: 900_000,
          ...(options.saveTo ? { save_to: options.saveTo } : {}),
          ...(options.ifExists ? { if_exists: options.ifExists } : {}),
        },
      },
      {
        id: "fim_sim",
        type: "end",
        label: "S",
        position: { x: 0, y: 100 },
        config: { outcome: "converted" },
      },
      {
        id: "fim_nr",
        type: "end",
        label: "N",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
      {
        id: "fim_else",
        type: "end",
        label: "E",
        position: { x: 0, y: 100 },
        config: { outcome: "custom" },
      },
    ],
    edges: [
      {
        id: "e_sim",
        source: "task",
        target: "fim_sim",
        condition: { type: "branch", branch_id: "b_sim" },
      },
      {
        id: "e_nr",
        source: "task",
        target: "fim_nr",
        condition: { type: "branch", branch_id: "no_reply" },
      },
      { id: "e_else", source: "task", target: "fim_else", condition: { type: "always" } },
    ],
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, GOV_ORG, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Pergunta ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until,lead_id)
     values($1,$2,$3,$4,$5,$6,$7,1,'task','active',now()-interval '1 second',now()+interval '2 minutes',$8)`,
    [
      run,
      GOV_ORG,
      flow,
      version,
      contact,
      origin.conversation_id,
      origin,
      options.withLead ? lead : null,
    ],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const jobs: { id: string; payload: Record<string, unknown> }[] = [];
  const depsDoFluxo = {
    ...deps,
    enqueueJob: async (job: { organization_id: string; contact_id: string; payload: unknown }) => {
      const id = randomUUID();
      await pool.query(
        "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
        [id, job.organization_id, job.contact_id, job.payload],
      );
      jobs.push({ id, payload: job.payload as Record<string, unknown> });
      return { job_id: id };
    },
  };
  const tick = async () => avancarEnrollmentAtivo({ ...depsDoFluxo, db: motorDb() }, await scope());
  // Job enfileirado com a passagem trocada: o `attachJob` o recusa DEPOIS de ele estar na fila.
  const tickComJobTorto = async () =>
    avancarEnrollmentAtivo(
      {
        ...deps,
        db: motorDb(),
        enqueueJob: async (job: { organization_id: string; contact_id: string; payload: unknown }) => {
          const id = randomUUID();
          await pool.query(
            "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
            [id, job.organization_id, job.contact_id, { ...(job.payload as object), source_step_key: "x" }],
          );
          jobs.push({ id, payload: job.payload as Record<string, unknown> });
          return { job_id: id };
        },
      },
      await scope(),
    );
  // O canal aceita a pergunta: recibo no ledger + conclusão do turno pelo mesmo caminho da ponte.
  const aceitaPergunta = async (job: string) => {
    await pool.query(
      `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values($1,$2,$3,1,'hash','accepted',$4)`,
      [GOV_ORG, contact, job, randomUUID()],
    );
    return journal.completeConfirmationSend(await scope(), job);
  };
  const responde = async (body: string) => {
    const id = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
       select $1::uuid,$2,c.id,c.channel_session_id,$3,'text','inbound','received',$4,now(),$1::text
       from conversations c where c.id=$5`,
      [id, GOV_ORG, contact, body, origin.conversation_id],
    );
    return id;
  };
  const attempts = async () =>
    (
      await pool.query(
        `select a.id,a.status,a.output_recorded,a.output_snapshot,s.status as step_status,s.branch_id
         from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='task' order by a.attempt_no`,
        [GOV_ORG, run],
      )
    ).rows;
  const venceEspera = () =>
    pool.query(
      `update followup_execution_attempts a set next_eval_at=now()-interval '1 second'
       from followup_execution_steps s
       where s.organization_id=a.organization_id and s.id=a.step_id and s.organization_id=$1 and s.enrollment_id=$2`,
      [GOV_ORG, run],
    );
  const contato = async () =>
    (
      await pool.query<{ name: string | null; custom_fields: Record<string, unknown> | null }>(
        "select name,custom_fields from contacts where organization_id=$1 and id=$2",
        [GOV_ORG, contact],
      )
    ).rows[0]!;
  const camposDoLead = async (id: string) =>
    (
      await pool.query<{ custom_fields: Record<string, unknown> | null }>(
        "select custom_fields from crm_leads where organization_id=$1 and id=$2",
        [GOV_ORG, id],
      )
    ).rows[0]!.custom_fields ?? {};
  return {
    run,
    contact,
    scope,
    tick,
    tickComJobTorto,
    jobs,
    aceitaPergunta,
    responde,
    attempts,
    venceEspera,
    contato,
    camposDoLead,
    lead,
    leadNovo,
  };
}

describe("match_reply no diário do contrato 1", () => {
  it("estaciona na espera (tentativa waiting) e não avança sem resposta antes do prazo", async () => {
    const f = await fixture();
    await f.tick();
    expect(await f.scope()).toMatchObject({
      current_node_id: "task",
      status: "waiting_reply",
      steps_taken: 1,
    });
    expect(await f.attempts()).toMatchObject([{ status: "waiting", output_recorded: false }]);
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
    expect(await f.attempts()).toHaveLength(1);
  });

  it("resposta que casa o ramo avança por ele e grava a saída com o id da mensagem", async () => {
    const f = await fixture();
    await f.tick();
    const msg = await f.responde("Sim");
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_sim", steps_taken: 2 });
    const [a] = await f.attempts();
    expect(a).toMatchObject({
      status: "succeeded",
      output_recorded: true,
      step_status: "succeeded",
      branch_id: "b_sim",
      output_snapshot: { matched: true, branch_id: "b_sim", reply_message_id: msg },
    });
    // O tick seguinte (replay) não duplica tentativa nem passo.
    await f.tick();
    expect(await f.attempts()).toHaveLength(1);
  });

  it("resposta que não casa segue o fallback com matched=false e o id da mensagem", async () => {
    const f = await fixture();
    await f.tick();
    const msg = await f.responde("talvez depois");
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_else", steps_taken: 2 });
    expect((await f.attempts())[0]).toMatchObject({
      status: "succeeded",
      output_snapshot: { matched: false, branch_id: "else", reply_message_id: msg },
    });
  });

  it("prazo vencido sem resposta segue no_reply, sem mensagem", async () => {
    const f = await fixture();
    await f.tick();
    await f.venceEspera();
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_nr", steps_taken: 2 });
    expect((await f.attempts())[0]).toMatchObject({
      status: "succeeded",
      branch_id: "no_reply",
      output_snapshot: { matched: false, branch_id: "no_reply", reply_message_id: null },
    });
  });

  describe("captação com confirmação (if_exists: confirm)", () => {
    const confirma = { saveTo: { kind: "contact_name" } as SaveTo, ifExists: "confirm" as const };

    it("campo preenchido: enfileira a pergunta ligada à tentativa e só espera DEPOIS do recibo", async () => {
      const f = await fixture(confirma);
      await f.tick();
      expect(f.jobs).toHaveLength(1);
      expect(f.jobs[0]!.payload).toMatchObject({ purpose: "send_message", node_id: "task" });
      expect(String(f.jobs[0]!.payload.fixed_body)).toContain("Ana");
      expect(await f.scope()).toMatchObject({ current_node_id: "task", status: "waiting_reply" });
      expect((await f.attempts())[0]).toMatchObject({ status: "running" });
      const linked = await pool.query(
        "select count(*)::int n from followup_execution_attempt_jobs where organization_id=$1 and job_id=$2",
        [GOV_ORG, f.jobs[0]!.id],
      );
      expect(linked.rows[0].n).toBe(1);

      await f.aceitaPergunta(f.jobs[0]!.id);
      expect((await f.attempts())[0]).toMatchObject({ status: "waiting", step_status: "waiting" });
      const efeitos = await pool.query(
        "select operation,status from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(efeitos.rows).toEqual([{ operation: "send_message", status: "confirmed" }]);
    });

    it("o resultado `sent` do turno pela ponte registra o recibo e estaciona a espera (não avança)", async () => {
      const f = await fixture(confirma);
      await f.tick();
      const job = f.jobs[0]!.id;
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, f.contact, job, randomUUID()],
      );
      const lockedAt = new Date().toISOString();
      await pool.query(
        "update job_queue set status='running', locked_by='w-1', locked_at=$3 where organization_id=$1 and id=$2",
        [GOV_ORG, job, lockedAt],
      );
      await completeTurnForEnrollment(adapter, GOV_ORG, f.run, "task", { kind: "sent" }, undefined, job, {
        worker_id: "w-1",
        acquired_at: lockedAt,
      });
      expect((await f.attempts())[0]).toMatchObject({ status: "waiting", step_status: "waiting" });
      expect((await f.scope()).current_node_id).toBe("task");
    });

    it("pergunta que ficou na fila além da carência: a espera conta do ACEITE, não do enfileiramento", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await pool.query(
        "update followup_enrollments set next_eval_at=now()-interval '1 hour' where organization_id=$1 and id=$2",
        [GOV_ORG, f.run],
      );
      await f.aceitaPergunta(f.jobs[0]!.id);
      const prazo = new Date((await f.scope()).next_eval_at!).getTime();
      expect(prazo).toBeGreaterThan(Date.now() + 14 * 60_000);
      await f.tick();
      expect((await f.scope()).current_node_id).toBe("task");
    });

    it("pergunta na fila além da janela por tempo: a tentativa segue do job vivo (sem tentativa órfã)", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await pool.query(
        `update followup_execution_attempts set started_at=now()-interval '10 days'
         where organization_id=$1 and step_id in (select id from followup_execution_steps where organization_id=$1 and enrollment_id=$2)`,
        [GOV_ORG, f.run],
      );
      await f.responde("Maria");
      await f.tick();
      await f.tick();
      expect(await f.attempts()).toHaveLength(1);
      expect(f.jobs).toHaveLength(1);
    });

    it("a resposta que ACORDOU a inscrição (updated_at regravado) ainda é lida depois do aceite", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.aceitaPergunta(f.jobs[0]!.id);
      await f.responde("Maria Souza");
      // O wake real regrava o updated_at depois da chegada da mensagem.
      await pool.query(
        "update followup_enrollments set updated_at=now()+interval '1 second' where organization_id=$1 and id=$2",
        [GOV_ORG, f.run],
      );
      await f.tick();
      expect((await f.contato()).name).toBe("Maria Souza");
      expect((await f.scope()).current_node_id).toBe("fim_else");
    });

    it("resposta ANTERIOR ao aceite da pergunta não vale como resposta a ela", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.responde("Joana"); // chegou antes de a pergunta sair
      await new Promise((r) => setTimeout(r, 50));
      await f.aceitaPergunta(f.jobs[0]!.id);
      await f.tick();
      expect((await f.contato()).name).toBe("Ana");
      expect((await f.scope()).current_node_id).toBe("task");
    });

    it("falha DEPOIS de a pergunta entrar na fila não reabre a tentativa nem enfileira outra", async () => {
      const f = await fixture(confirma);
      await expect(f.tickComJobTorto()).rejects.toBeTruthy();
      expect(f.jobs).toHaveLength(1);
      expect((await f.attempts())[0]).toMatchObject({ status: "running" });
      await f.tick().catch(() => undefined);
      expect(f.jobs).toHaveLength(1);
    });

    it("vínculo do job recusado: quando a inscrição volta (claim novo), a tentativa órfã é encerrada, não fica presa", async () => {
      const f = await fixture(confirma);
      await expect(f.tickComJobTorto()).rejects.toBeTruthy();
      expect((await f.attempts())[0]).toMatchObject({ status: "running" });
      // O scheduler reclama a inscrição depois de o claim vencer: lease novo para a mesma tentativa.
      await pool.query(
        "update followup_enrollments set claimed_until=now()+interval '2 minutes', next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
        [GOV_ORG, f.run],
      );
      await f.tick().catch(() => undefined);
      const tentativas = await f.attempts();
      expect(tentativas[0]!.status).not.toBe("running");
    });

    it("job terminal SEM recibo não segura a inscrição: a tentativa deixa de ficar presa", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await pool.query("update job_queue set status='failed' where organization_id=$1 and id=$2", [
        GOV_ORG,
        f.jobs[0]!.id,
      ]);
      await f.responde("Maria");
      await f.tick();
      expect((await f.attempts())[0]!.status).not.toBe("running");
    });

    it("repetir a conclusão do envio é no-op (sem segundo efeito)", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.aceitaPergunta(f.jobs[0]!.id);
      expect(await journal.completeConfirmationSend(await f.scope(), f.jobs[0]!.id)).toEqual({
        reused: true,
      });
      const n = await pool.query(
        "select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2",
        [GOV_ORG, f.run],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it("sem recibo aceito pelo canal a pergunta NÃO conta como enviada", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await expect(
        journal.completeConfirmationSend(await f.scope(), f.jobs[0]!.id),
      ).rejects.toMatchObject({ code: "execution_send_receipt_missing" });
      expect((await f.attempts())[0]).toMatchObject({ status: "running" });
    });

    it("resposta antes do envio da pergunta: não decide nem enfileira a pergunta de novo", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.responde("Maria");
      await f.tick();
      await f.tick();
      expect(f.jobs).toHaveLength(1);
      expect(await f.attempts()).toHaveLength(1);
      expect((await f.scope()).current_node_id).toBe("task");
    });

    it("'sim' mantém o valor gravado: avança sem sobrescrever", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.aceitaPergunta(f.jobs[0]!.id);
      await f.responde("Sim");
      await f.tick();
      expect((await f.contato()).name).toBe("Ana");
      expect((await f.scope()).current_node_id).toBe("fim_else");
      expect((await f.attempts())[0]).toMatchObject({ status: "succeeded" });
    });

    it("outra resposta corrige o valor e avança na mesma transação", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.aceitaPergunta(f.jobs[0]!.id);
      await f.responde("Maria Souza");
      await f.tick();
      expect((await f.contato()).name).toBe("Maria Souza");
      expect((await f.scope()).current_node_id).toBe("fim_else");
    });

    it("sem resposta no prazo: segue no_reply e não grava", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await f.aceitaPergunta(f.jobs[0]!.id);
      await f.venceEspera();
      await f.tick();
      expect((await f.scope()).current_node_id).toBe("fim_nr");
      expect((await f.contato()).name).toBe("Ana");
      expect(f.jobs).toHaveLength(1);
    });

    it("pergunta pulada (opt-out/inelegível) fecha a tentativa como skipped e cancela", async () => {
      const f = await fixture(confirma);
      await f.tick();
      await journal.completeSkipped(await f.scope(), f.jobs[0]!.id, "opt_out");
      expect((await f.attempts())[0]).toMatchObject({ status: "skipped", step_status: "skipped" });
      expect(await f.scope()).toMatchObject({ status: "cancelled", cancel_reason: "opt_out" });
    });

    it("pergunta adiada pela janela: a tentativa segue aberta e a inscrição volta depois da carência", async () => {
      const f = await fixture(confirma);
      await f.tick();
      const ate = new Date(Date.now() + 3 * 3600_000);
      const volta = new Date(ate.getTime() + 3600_000);
      await journal.deferSend(await f.scope(), f.jobs[0]!.id, ate, volta, "fora_da_janela");
      expect((await f.attempts())[0]).toMatchObject({ status: "running" });
      expect(new Date((await f.scope()).next_eval_at!).getTime()).toBe(volta.getTime());
    });
  });

  it("concluir a decisão com saída fora do contrato é recusado (branch divergente)", async () => {
    const f = await fixture();
    await f.tick();
    await f.responde("sim");
    const begun = await journal.begin(await f.scope(), {});
    if (begun.kind !== "ready") throw new Error("expected_ready");
    await expect(
      journal.completeDecision(
        await f.scope(),
        begun.handle,
        { kind: "advance", next_node_id: "fim_sim", next_eval_at: new Date() },
        {
          edge_id: "e_sim",
          branch_id: "b_sim",
          output: { matched: true, branch_id: "outro", reply_message_id: null },
        },
      ),
    ).rejects.toThrow("execution_branch_mismatch");
    expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
  });

  describe("captação (save_to) nos modos overwrite e skip", () => {
    it("overwrite: a resposta grava o nome do contato e avança na mesma transação", async () => {
      const f = await fixture({ saveTo: { kind: "contact_name" } });
      await f.tick();
      expect((await f.scope()).status).toBe("waiting_reply");
      const msg = await f.responde("  Maria Souza  ");
      await f.tick();
      expect((await f.contato()).name).toBe("Maria Souza");
      expect(await f.scope()).toMatchObject({ current_node_id: "fim_else", steps_taken: 2 });
      expect((await f.attempts())[0]).toMatchObject({
        status: "succeeded",
        output_snapshot: { matched: false, branch_id: "else", reply_message_id: msg },
      });
    });

    it("overwrite em campo do contato preserva os outros campos", async () => {
      const f = await fixture({ saveTo: { kind: "contact_custom", key: "cidade" } });
      await pool.query("update contacts set custom_fields=$3 where organization_id=$1 and id=$2", [
        GOV_ORG,
        f.contact,
        { origem: "site" },
      ]);
      await f.tick();
      await f.responde("Salvador");
      await f.tick();
      expect((await f.contato()).custom_fields).toEqual({ origem: "site", cidade: "Salvador" });
    });

    it("campo do negócio vai para o Lead EXPLÍCITO da inscrição, nunca para o mais recente", async () => {
      const f = await fixture({
        saveTo: { kind: "lead_custom", key: "orcamento" },
        withLead: true,
      });
      await f.tick();
      await f.responde("5 mil");
      await f.tick();
      expect(await f.camposDoLead(f.lead!)).toEqual({ orcamento: "5 mil" });
      expect(await f.camposDoLead(f.leadNovo!)).toEqual({});
      expect((await f.scope()).current_node_id).toBe("fim_else");
    });

    it("campo do negócio sem Lead explícito: falha fechada, não grava em Lead nenhum nem avança", async () => {
      const f = await fixture({
        saveTo: { kind: "lead_custom", key: "orcamento" },
        withLead: false,
      });
      await f.tick();
      await f.responde("5 mil");
      await f.tick();
      const s = await f.scope();
      expect(s.current_node_id).toBe("task");
      expect(s.last_error).toBe("execution_lead_required");
      expect(await f.camposDoLead(f.lead!)).toEqual({});
      expect(await f.camposDoLead(f.leadNovo!)).toEqual({});
      expect((await f.attempts()).some((a) => a.status === "succeeded")).toBe(false);
    });

    it("skip com o campo já preenchido: segue sem perguntar nem esperar, e não grava", async () => {
      const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "skip" });
      await f.tick();
      expect(await f.scope()).toMatchObject({ current_node_id: "fim_else", steps_taken: 1 });
      expect((await f.contato()).name).toBe("Ana");
      expect((await f.attempts())[0]).toMatchObject({
        status: "succeeded",
        output_snapshot: { matched: false, branch_id: "else", reply_message_id: null },
      });
    });

    it("skip com o campo vazio: espera a resposta, avança e NÃO grava (mesma regra do legado)", async () => {
      const f = await fixture({
        saveTo: { kind: "contact_name" },
        ifExists: "skip",
        contactName: null,
      });
      await f.tick();
      expect((await f.scope()).status).toBe("waiting_reply");
      await f.responde("Maria");
      await f.tick();
      expect((await f.scope()).current_node_id).toBe("fim_else");
      expect((await f.contato()).name).toBeNull();
    });

    it("texto do webhook com a mensagem ainda não gravada: não decide nem grava; o tick seguinte grava o corpo inteiro", async () => {
      const f = await fixture({ saveTo: { kind: "contact_name" } });
      await f.tick();
      await aplicarRespostaInbound(deps, await f.scope(), "Maria");
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
      expect((await f.contato()).name).toBe("Ana");
      await f.responde("Maria Souza da Silva");
      await f.tick();
      expect((await f.scope()).current_node_id).toBe("fim_else");
      expect((await f.contato()).name).toBe("Maria Souza da Silva");
    });

    it("sem resposta no prazo: segue no_reply e não grava nada", async () => {
      const f = await fixture({ saveTo: { kind: "contact_name" } });
      await f.tick();
      await f.venceEspera();
      await f.tick();
      expect((await f.scope()).current_node_id).toBe("fim_nr");
      expect((await f.contato()).name).toBe("Ana");
    });
  });
});
