import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PgExecutionJournal,
  type ExecutionAttemptHandle,
} from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type * as ContractModule from "@/lib/followup/execution-contract";

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
import { GOV_ORG, seedGov } from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 12,
});
const journal = new PgExecutionJournal(pool);
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

async function fixture(decision: "ai_classify" | "action", graceMs = 900_000) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const cfg =
    decision === "ai_classify"
      ? { classes: ["quente", "frio"], grace_timeout_ms: graceMs, target: "last_reply" }
      : { mode: "text", body: "Olá" };
  const edges =
    decision === "ai_classify"
      ? [
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
        ]
      : [{ id: "next", source: "task", target: "end", condition: { type: "always" } }];
  const graph = {
    execution_contract: 1,
    nodes: [
      { id: "task", type: decision, label: "N", position: { x: 0, y: 0 }, config: cfg },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "exhausted" },
      },
    ],
    edges,
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, GOV_ORG, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Borda ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,1,'task','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const input = { contact_id: contact, source: "synthetic", purpose: "classify" };
  const begin = async (): Promise<ExecutionAttemptHandle> => {
    const r = await journal.begin(await scope(), input);
    if (r.kind !== "ready") throw new Error("expected_ready");
    return r.handle;
  };
  const novoLease = () =>
    pool.query(
      "update followup_enrollments set claimed_until=now()+interval '3 minutes' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  const mkJob = async () => {
    const id = randomUUID();
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'followup_turn',$4)",
      [
        id,
        GOV_ORG,
        contact,
        { followup_enrollment_id: run, node_id: "task", source_step_key: "task:0" },
      ],
    );
    return id;
  };
  return { contact, run, scope, input, begin, novoLease, mkJob };
}

const HORA = 3_600_000;
const janela = (graceMs: number) => Math.max(24 * HORA, 2 * graceMs);

/** started_at forjado em relação ao now() DO BANCO (delta em ms; negativo = dentro da janela). */
async function borda(graceMs: number, deltaMs: number) {
  const f = await fixture("ai_classify", graceMs);
  const h = await f.begin();
  await pool.query(
    "update followup_execution_attempts set started_at=now()-(($3::double precision) * interval '1 millisecond') where organization_id=$1 and id=$2",
    [GOV_ORG, h.attempt_id, janela(graceMs) + deltaMs],
  );
  await f.novoLease();
  const again = await journal.begin(await f.scope(), f.input);
  if (again.kind !== "ready") throw new Error("expected_ready");
  return { reaproveitou: again.handle.attempt_id === h.attempt_id, no: again.handle.attempt_no };
}

describe("bordas EXATAS da janela de reaproveitamento do begin (ai_classify), +-1 s", () => {
  for (const [nome, grace] of [
    ["carência mínima (900000 ms => piso de 24 h)", 900_000],
    ["carência de 3 dias (janela = 6 dias)", 72 * HORA],
    ["carência de 365 dias (teto da publicação)", 31_536_000_000],
  ] as const) {
    it(`${nome}: 1 s dentro reaproveita (attempt_no 1); 1 s fora cai no lease interrompido (attempt_no 2)`, async () => {
      expect(await borda(grace, -1000)).toEqual({ reaproveitou: true, no: 1 });
      expect(await borda(grace, +1000)).toEqual({ reaproveitou: false, no: 2 });
    });
  }

  it("fora da janela o ai_classify CONSOME o orçamento: com max_attempts=1, a 3a volta fora da janela termina em 'stopped'", async () => {
    const f = await fixture("ai_classify");
    await pool.query(
      "update followup_enrollments set max_attempts=1 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    const velhice = (id: string) =>
      pool.query(
        "update followup_execution_attempts set started_at=now()-interval '10 days' where organization_id=$1 and id=$2",
        [GOV_ORG, id],
      );
    const h1 = await f.begin();
    await velhice(h1.attempt_id);
    await f.novoLease();
    const r2 = await journal.begin(await f.scope(), f.input);
    if (r2.kind !== "ready") throw new Error("expected_ready");
    expect(r2.handle.attempt_no).toBe(2);
    await velhice(r2.handle.attempt_id);
    await f.novoLease();
    const r3 = await journal.begin(await f.scope(), f.input);
    expect(r3.kind).toBe("stopped");
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_attempt_budget_exhausted",
    });
  });

  it("carência EXTREMA (9e15 ms, grafo legado): o teto interno evita `interval out of range` e reaproveita", async () => {
    const f = await fixture("ai_classify", 9_000_000_000_000_000);
    const r1 = await f.begin();
    expect(r1.attempt_no).toBe(1);
    await f.novoLease();
    const r2 = await journal.begin(await f.scope(), f.input);
    if (r2.kind !== "ready") throw new Error("expected_ready");
    expect(r2.handle.attempt_no).toBe(1);
    const a = await fixture("action");
    await expect(a.begin()).resolves.toBeTruthy();
  });
});

describe("deferSend / completeSend REAIS concorrentes do mesmo job (conexões distintas)", () => {
  const RODADAS = 12;
  const quando = () => new Date(Date.now() + 3600_000);
  async function preparado() {
    const f = await fixture("action");
    const h = await f.begin();
    const job = await f.mkJob();
    await journal.attachJob(await f.scope(), h, job);
    return { f, h, job };
  }
  const eventos = async (run: string) =>
    (
      await pool.query(
        "select idempotency_key from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='action_deferred'",
        [GOV_ORG, run],
      )
    ).rows;
  const steps = async (run: string) =>
    Number(
      (
        await pool.query(
          "select steps_taken from followup_enrollments where organization_id=$1 and id=$2",
          [GOV_ORG, run],
        )
      ).rows[0].steps_taken,
    );

  for (const n of [2, 3]) {
    it(`${n} deferSend concorrentes: 1 evento, 1 reused:false e ${n - 1} reused:true, sem 23505, steps_taken inalterado (${RODADAS} rodadas)`, async () => {
      let stale = 0;
      for (let i = 0; i < RODADAS; i++) {
        const { f, job } = await preparado();
        const t = quando();
        const r = await Promise.allSettled(
          Array.from({ length: n }, async () =>
            journal.deferSend(await f.scope(), job, t, t, "janela"),
          ),
        );
        // Quem perde a corrida pode ver a revisão mudar (Stale): o worker relê e repete; nunca 23505.
        const vals: boolean[] = [];
        for (const x of r) {
          if (x.status === "fulfilled") vals.push(x.value.reused);
          else {
            expect(String(x.reason)).toMatch(/service_boundary_stale/);
            stale++;
            vals.push((await journal.deferSend(await f.scope(), job, t, t, "janela")).reused);
          }
        }
        expect(vals.filter((v) => !v)).toHaveLength(1);
        expect(vals.filter((v) => v)).toHaveLength(n - 1);
        const ev = await eventos(f.run);
        expect(ev).toHaveLength(1);
        expect(ev[0].idempotency_key).toBe(`task:0:adiado:${job}`);
        expect(await steps(f.run)).toBe(0);
      }
      process.stderr.write(`[defer x${n}] Stale observados (retentados): ${stale}\n`);
    });
  }

  it(`deferSend concorrente com completeSend do mesmo job: nunca 23505; <=1 adiamento; tentativa conclui no maximo uma vez (${RODADAS} rodadas)`, async () => {
    const vistos = new Set<string>();
    for (let i = 0; i < RODADAS; i++) {
      const { f, job } = await preparado();
      await pool.query(
        `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
         values($1,$2,$3,1,'hash','accepted',$4)`,
        [GOV_ORG, f.contact, job, randomUUID()],
      );
      const t = quando();
      const [d, c] = await Promise.allSettled([
        (async () => journal.deferSend(await f.scope(), job, t, t, "janela"))(),
        (async () => journal.completeSend(await f.scope(), job))(),
      ]);
      for (const x of [d, c])
        if (x.status === "rejected") expect(String(x.reason)).not.toMatch(/23505|duplicate key/);
      const ev = await eventos(f.run);
      expect(ev.length).toBeLessThanOrEqual(1);
      const att = await pool.query(
        `select count(*) filter (where a.status='succeeded')::int ok from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and s.enrollment_id=$2`,
        [GOV_ORG, f.run],
      );
      expect(att.rows[0].ok).toBeLessThanOrEqual(1);
      const s = await steps(f.run);
      expect(s).toBeLessThanOrEqual(1);
      vistos.add(
        `defer=${d.status}${d.status === "fulfilled" ? d.value.reused : ""} complete=${c.status}${c.status === "rejected" ? ":" + String(c.reason).slice(0, 60) : ""} ev=${ev.length} steps=${s}`,
      );
    }
    process.stderr.write(`[defer x complete] desfechos: ${JSON.stringify([...vistos])}\n`);
  });
});

describe("contador de reaproveitamento da tentativa (migration 0708)", () => {
  const LIMITE = 5;
  const tentativa = async (id: string) =>
    (
      await pool.query<{ reuse_count: number; status: string; error_snapshot: { code?: string } | null }>(
        "select reuse_count,status,error_snapshot from followup_execution_attempts where organization_id=$1 and id=$2",
        [GOV_ORG, id],
      )
    ).rows[0]!;
  const reentra = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await f.novoLease();
    return journal.begin(await f.scope(), f.input);
  };

  it(`dentro da janela reaproveita ${LIMITE} vezes contando; a ${LIMITE + 1}a reentrada fecha a tentativa e abre attempt_no 2`, async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    expect((await tentativa(h1.attempt_id)).reuse_count).toBe(0);
    for (let n = 1; n <= LIMITE; n++) {
      const r = await reentra(f);
      if (r.kind !== "ready") throw new Error("expected_ready");
      expect(r.handle.attempt_id).toBe(h1.attempt_id);
      expect((await tentativa(h1.attempt_id)).reuse_count).toBe(n);
    }
    const r = await reentra(f);
    if (r.kind !== "ready") throw new Error("expected_ready");
    expect(r.handle.attempt_no).toBe(2);
    expect(await tentativa(h1.attempt_id)).toMatchObject({
      reuse_count: LIMITE,
      status: "failed",
      error_snapshot: { code: "execution_lease_interrupted" },
    });
    expect((await tentativa(r.handle.attempt_id)).reuse_count).toBe(0);
  });

  it("o limite consome o orçamento: com max_attempts=1, esgotar o contador duas vezes termina em 'stopped' e inscrição 'dead'", async () => {
    const f = await fixture("ai_classify");
    await pool.query(
      "update followup_enrollments set max_attempts=1 where organization_id=$1 and id=$2",
      [GOV_ORG, f.run],
    );
    await f.begin();
    for (let n = 0; n < LIMITE; n++) await reentra(f);
    const r2 = await reentra(f);
    if (r2.kind !== "ready") throw new Error("expected_ready");
    expect(r2.handle.attempt_no).toBe(2);
    for (let n = 0; n < LIMITE; n++) await reentra(f);
    const r3 = await reentra(f);
    expect(r3.kind).toBe("stopped");
    expect(await f.scope()).toMatchObject({
      status: "dead",
      last_error: "execution_attempt_budget_exhausted",
    });
  });

  it("schema: default 0, recusa negativo e a migration é idempotente", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "supabase/migrations/20261022090000_0708_execucoes_contador_de_reaproveitamento.sql",
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const f = await fixture("ai_classify");
    const h = await f.begin();
    expect((await tentativa(h.attempt_id)).reuse_count).toBe(0);
    await expect(
      pool.query("update followup_execution_attempts set reuse_count=-1 where organization_id=$1 and id=$2", [
        GOV_ORG,
        h.attempt_id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("contador × resposta do contato: job NOVO ligado zera o contador (achado da 2c)", () => {
  const contador = async (id: string) =>
    (
      await pool.query<{ reuse_count: number }>(
        "select reuse_count from followup_execution_attempts where organization_id=$1 and id=$2",
        [GOV_ORG, id],
      )
    ).rows[0]!.reuse_count;

  it("12 reentradas, cada uma ligando um job novo (rajada de respostas), mantêm a MESMA tentativa e o 1º job ainda conclui", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    const j1 = await f.mkJob();
    await journal.attachJob(await f.scope(), h1, j1);
    for (let n = 0; n < 12; n++) {
      await f.novoLease();
      const r = await journal.begin(await f.scope(), f.input);
      if (r.kind !== "ready") throw new Error("expected_ready");
      expect(r.handle.attempt_id).toBe(h1.attempt_id);
      expect(await contador(h1.attempt_id)).toBe(1);
      await journal.attachJob(await f.scope(), r.handle, await f.mkJob());
      expect(await contador(h1.attempt_id)).toBe(0);
    }
    await journal.completeClassification(await f.scope(), j1, "quente");
    expect(await f.scope()).toMatchObject({ steps_taken: 1 });
  });

  it("religar o MESMO job não zera: só job novo prova que a reentrada chegou ao fim", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    const j1 = await f.mkJob();
    await journal.attachJob(await f.scope(), h1, j1);
    await f.novoLease();
    const r = await journal.begin(await f.scope(), f.input);
    if (r.kind !== "ready") throw new Error("expected_ready");
    await journal.attachJob(await f.scope(), r.handle, j1);
    expect(await contador(h1.attempt_id)).toBe(1);
  });
});

describe("teto absoluto de jobs ligados por tentativa (job que nunca conclui)", () => {
  it("com 50 jobs ligados a 51a reentrada não reaproveita: fecha a tentativa e abre attempt_no 2", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    for (let n = 0; n < 50; n++) {
      const job = await f.mkJob();
      await pool.query(
        "insert into followup_execution_attempt_jobs (organization_id,attempt_id,job_id) values ($1,$2,$3)",
        [GOV_ORG, h1.attempt_id, job],
      );
    }
    await f.novoLease();
    const r = await journal.begin(await f.scope(), f.input);
    if (r.kind !== "ready") throw new Error("expected_ready");
    expect(r.handle.attempt_no).toBe(2);
    const prev = await pool.query<{ status: string }>(
      "select status from followup_execution_attempts where organization_id=$1 and id=$2",
      [GOV_ORG, h1.attempt_id],
    );
    expect(prev.rows[0]!.status).toBe("failed");
  });

  it("com 49 jobs ligados ainda reaproveita a mesma tentativa", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    for (let n = 0; n < 49; n++) {
      const job = await f.mkJob();
      await pool.query(
        "insert into followup_execution_attempt_jobs (organization_id,attempt_id,job_id) values ($1,$2,$3)",
        [GOV_ORG, h1.attempt_id, job],
      );
    }
    await f.novoLease();
    const r = await journal.begin(await f.scope(), f.input);
    if (r.kind !== "ready") throw new Error("expected_ready");
    expect(r.handle.attempt_id).toBe(h1.attempt_id);
  });
});
