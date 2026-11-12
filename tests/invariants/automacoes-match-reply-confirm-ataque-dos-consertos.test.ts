import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aplicarRespostaInbound, avancarEnrollmentAtivo } from "@/lib/followup/engine";
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
  const tick = async () => avancarEnrollmentAtivo(depsDoFluxo, await scope());
  // Job enfileirado com a passagem trocada: o `attachJob` o recusa DEPOIS de ele estar na fila.
  const tickComJobTorto = async () =>
    avancarEnrollmentAtivo(
      {
        ...deps,
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

const aceiteGravado = async (run: string) =>
  new Date(
    (
      await pool.query<{ a: string }>(
        `select payload->>'accepted_at' a from followup_enrollment_events
         where organization_id=$1 and enrollment_id=$2 and event_type='confirmation_sent' order by created_at desc limit 1`,
        [GOV_ORG, run],
      )
    ).rows[0]!.a,
  ).getTime();
const inboundEm = async (f: Awaited<ReturnType<typeof fixture>>, body: string, quando: number) => {
  const id = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
     select $1::uuid,$2,c.id,c.channel_session_id,$3,'text','inbound','received',$4,$6::timestamptz,$1::text
     from conversations c join followup_enrollments e on e.conversation_id=c.id where e.id=$5`,
    [id, GOV_ORG, (await f.scope()).contact_id, body, f.run, new Date(quando).toISOString()],
  );
  return id;
};
// O wake real (inbound_woke) regrava updated_at e libera o claim para o próximo tick.
const acordaComoOWebhook = (f: Awaited<ReturnType<typeof fixture>>) =>
  pool.query(
    "update followup_enrollments set updated_at=now(), next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2",
    [GOV_ORG, f.run],
  );
const expiraClaim = (f: Awaited<ReturnType<typeof fixture>>) =>
  pool.query(
    "update followup_enrollments set claimed_until=now()-interval '1 second', next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
    [GOV_ORG, f.run],
  );
const reclama = (f: Awaited<ReturnType<typeof fixture>>) =>
  pool.query(
    "update followup_enrollments set claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2",
    [GOV_ORG, f.run],
  );
const confirma = { saveTo: { kind: "contact_name" } as SaveTo, ifExists: "confirm" as const };

describe("confirm: ataque aos 3 consertos (piso do aceite, pergunta na fila, job morto)", () => {
  it("(1a) resposta ANTERIOR ao aceite nao vale, mesmo com o wake regravando updated_at", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await f.aceitaPergunta(f.jobs[0]!.id);
    const aceite = await aceiteGravado(f.run);
    await inboundEm(f, "Maria Antiga", aceite - 5000);
    await acordaComoOWebhook(f);
    await f.tick();
    expect((await f.contato()).name).toBe("Ana");
    expect((await f.scope()).current_node_id).toBe("task");
  });

  it("(1b) resposta POSTERIOR ao aceite, com updated_at regravado depois dela: grava e avanca", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await f.aceitaPergunta(f.jobs[0]!.id);
    const aceite = await aceiteGravado(f.run);
    await inboundEm(f, "Maria Nova", aceite + 1000);
    await acordaComoOWebhook(f);
    await f.tick();
    expect((await f.contato()).name).toBe("Maria Nova");
    expect((await f.scope()).current_node_id).toBe("fim_else");
  });

  it("(1c) resposta no MESMO instante do aceite (borda): medido", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await f.aceitaPergunta(f.jobs[0]!.id);
    const aceite = await aceiteGravado(f.run);
    await inboundEm(f, "Maria Borda", aceite);
    await acordaComoOWebhook(f);
    await f.tick();
    process.stderr.write(`[borda do aceite] nome=${(await f.contato()).name}\n`);
    expect((await f.contato()).name).toBe("Maria Borda");
  });

  it("(1d) aceite com sent_at da mensagem da pergunta: o piso e o sent_at, nao o relogio do ledger", async () => {
    const f = await fixture(confirma);
    await f.tick();
    const msgId = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at)
       select $1::uuid,$2,c.id,c.channel_session_id,$3,'text','outbound','sent','pergunta',now()-interval '30 minutes'
       from conversations c join followup_enrollments e on e.conversation_id=c.id where e.id=$4`,
      [msgId, GOV_ORG, (await f.scope()).contact_id, f.run],
    );
    await pool.query(
      `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values($1,$2,$3,1,'h','accepted',$4)`,
      [GOV_ORG, (await f.scope()).contact_id, f.jobs[0]!.id, msgId],
    );
    await journal.completeConfirmationSend(await f.scope(), f.jobs[0]!.id);
    const aceite = await aceiteGravado(f.run);
    expect(Math.abs(aceite - (Date.now() - 30 * 60_000))).toBeLessThan(60_000);
    // resposta 10 min atras (depois do aceite de 30 min atras): vale.
    await inboundEm(f, "Maria 10min", Date.now() - 10 * 60_000);
    await acordaComoOWebhook(f);
    await f.tick();
    process.stderr.write(`[aceite antigo] nome=${(await f.contato()).name} no=${(await f.scope()).current_node_id}\n`);
    expect((await f.contato()).name).toBe("Maria 10min");
  });

  it("(2a) attachJob recusado e a inscricao volta DEPOIS (claim vence): nao pode sair uma 2a pergunta", async () => {
    const f = await fixture(confirma);
    await f.tickComJobTorto().catch(() => undefined);
    expect(f.jobs).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await expiraClaim(f);
      await f.tick().catch(() => undefined);
    }
    process.stderr.write(`[attach recusado, 3 ticks] jobs=${f.jobs.length} tentativas=${(await f.attempts()).map((a) => a.status).join(",")}\n`);
    expect(f.jobs).toHaveLength(1);
  });

  it("(2b) enqueueJob lanca (nada na fila): a pergunta nao se perde e sai no maximo uma vez", async () => {
    const f = await fixture(confirma);
    await avancarEnrollmentAtivo(
      {
        ...deps,
        enqueueJob: async () => {
          throw new Error("fila_fora");
        },
      },
      await f.scope(),
    ).catch(() => undefined);
    expect(f.jobs).toHaveLength(0);
    for (let i = 0; i < 3 && f.jobs.length === 0; i++) {
      await expiraClaim(f);
      await reclama(f);
      await f.tick().catch(() => undefined);
    }
    process.stderr.write(`[enqueue lancou] jobs=${f.jobs.length} tentativas=${(await f.attempts()).map((a) => a.status).join(",")}\n`);
    expect(f.jobs.length).toBe(1);
  });

  it("(3a) job pending ha 10 dias e a pergunta e aceita: espera conta do aceite e a resposta vale", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await pool.query(
      "update followup_execution_attempts set started_at=now()-interval '10 days' where organization_id=$1 and step_id in (select id from followup_execution_steps where organization_id=$1 and enrollment_id=$2)",
      [GOV_ORG, f.run],
    );
    await expiraClaim(f);
    await reclama(f);
    await f.tick();
    expect(f.jobs).toHaveLength(1);
    expect(await f.attempts()).toHaveLength(1);
    await f.aceitaPergunta(f.jobs[0]!.id);
    const aceite = await aceiteGravado(f.run);
    await inboundEm(f, "Maria Tarde", aceite + 500);
    await acordaComoOWebhook(f);
    await f.tick();
    expect((await f.contato()).name).toBe("Maria Tarde");
  });

  it("(3b) job 'failed' sem recibo: a tentativa nao fica running e no maximo UMA pergunta nova por tentativa", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await pool.query("update job_queue set status='failed' where organization_id=$1 and id=$2", [GOV_ORG, f.jobs[0]!.id]);
    for (let i = 0; i < 4; i++) {
      await expiraClaim(f);
      await reclama(f);
      await f.tick().catch(() => undefined);
    }
    const st = (await f.attempts()).map((a) => a.status);
    process.stderr.write(`[job failed, 4 ticks] jobs=${f.jobs.length} tentativas=${st.join(",")} enrollment=${(await f.scope()).status}\n`);
    expect(st.filter((s) => s === "running").length).toBeLessThanOrEqual(1);
    expect(f.jobs.length).toBeLessThanOrEqual(st.length);
  });

  it("(3c) job 'running' (worker vivo) com a inscricao reclamada de novo: nao decide nem re-enfileira", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await pool.query("update job_queue set status='running', locked_by='w', locked_at=now() where organization_id=$1 and id=$2", [GOV_ORG, f.jobs[0]!.id]);
    await f.responde("Maria Cedo");
    for (let i = 0; i < 3; i++) {
      await expiraClaim(f);
      await reclama(f);
      await f.tick().catch(() => undefined);
    }
    expect(f.jobs).toHaveLength(1);
    expect(await f.attempts()).toHaveLength(1);
    expect((await f.contato()).name).toBe("Ana");
  });

  it("(4) corrida: 3 aceites simultaneos + resposta + tick: 1 efeito, nenhuma gravacao dupla", async () => {
    for (let r = 0; r < 6; r++) {
      const f = await fixture(confirma);
      await f.tick();
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, (await f.scope()).contact_id, f.jobs[0]!.id, randomUUID()],
      );
      const scope = await f.scope();
      const res = await Promise.allSettled([
        journal.completeConfirmationSend(scope, f.jobs[0]!.id),
        journal.completeConfirmationSend(scope, f.jobs[0]!.id),
        journal.completeConfirmationSend(scope, f.jobs[0]!.id),
      ]);
      for (const x of res) if (x.status === "rejected") expect(String(x.reason)).toMatch(/stale|execution_|serializ|deadlock/i);
      expect(res.some((x) => x.status === "fulfilled")).toBe(true);
      const n = await pool.query("select count(*)::int n from followup_execution_effects where organization_id=$1 and enrollment_id=$2", [GOV_ORG, f.run]);
      expect(n.rows[0].n).toBe(1);
      const ev = await pool.query("select count(*)::int n from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='confirmation_sent'", [GOV_ORG, f.run]);
      expect(ev.rows[0].n).toBe(1);
    }
  });

  it("(5) resposta durante a pergunta em voo (antes do aceite): fica de fora por desenho; sem erro e sem captar", async () => {
    const f = await fixture(confirma);
    await f.tick();
    await f.responde("Maria Antes");
    await f.tick();
    await f.aceitaPergunta(f.jobs[0]!.id);
    await acordaComoOWebhook(f);
    await f.tick();
    expect((await f.contato()).name).toBe("Ana");
    expect((await f.scope()).current_node_id).toBe("task");
  });
});
