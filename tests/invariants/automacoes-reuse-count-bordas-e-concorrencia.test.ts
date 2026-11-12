import { readFileSync } from "node:fs";
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
const abertas = async (run: string) =>
  Number(
    (
      await pool.query(
        `select count(*) filter (where a.status='running')::int n from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and s.enrollment_id=$2`,
        [GOV_ORG, run],
      )
    ).rows[0].n,
  );

describe("contador de reaproveitamento: bordas 4, 5 e 6", () => {
  for (const n of [4, 5, 6]) {
    it(`apos ${n} reentradas: ${n <= LIMITE ? `mesma tentativa, reuse_count=${n}` : "tentativa 1 fechada (failed) com contador=5 e attempt_no=2 com contador 0"}`, async () => {
      const f = await fixture("ai_classify");
      const h1 = await f.begin();
      let ultimo: Awaited<ReturnType<typeof reentra>> | undefined;
      for (let i = 0; i < n; i++) ultimo = await reentra(f);
      if (!ultimo || ultimo.kind !== "ready") throw new Error("expected_ready");
      if (n <= LIMITE) {
        expect(ultimo.handle.attempt_id).toBe(h1.attempt_id);
        expect((await tentativa(h1.attempt_id)).reuse_count).toBe(n);
      } else {
        expect(ultimo.handle.attempt_no).toBe(2);
        expect(await tentativa(h1.attempt_id)).toMatchObject({ reuse_count: LIMITE, status: "failed" });
        expect((await tentativa(ultimo.handle.attempt_id)).reuse_count).toBe(0);
      }
      expect(await abertas(f.run)).toBe(1);
    });
  }

  it("mesmo lease reentrando (sem novo claim) NAO sobe o contador", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    await reentra(f);
    for (let i = 0; i < 3; i++) await journal.begin(await f.scope(), f.input);
    expect((await tentativa(h1.attempt_id)).reuse_count).toBe(1);
  });

  it("o contador so vale para ai_classify: action reentrando com lease novo nao reaproveita", async () => {
    const f = await fixture("action");
    const h1 = await f.begin();
    const r = await reentra(f);
    if (r.kind !== "ready") throw new Error("expected_ready");
    expect(r.handle.attempt_id).not.toBe(h1.attempt_id);
    expect((await tentativa(h1.attempt_id)).reuse_count).toBe(0);
  });
});

describe("contador de reaproveitamento: concorrencia de begin na mesma tentativa", () => {
  it("2 begin simultaneos com leases proprios: nunca perde incremento (1..2), nunca 2 abertas, so Stale como erro (15 rodadas)", async () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const f = await fixture("ai_classify");
      const h1 = await f.begin();
      const r = await Promise.allSettled([reentra(f), reentra(f)]);
      for (const x of r)
        if (x.status === "rejected") expect(String(x.reason)).toMatch(/service_boundary_stale/);
      const t = await tentativa(h1.attempt_id);
      expect(t.reuse_count).toBeGreaterThanOrEqual(1);
      expect(t.reuse_count).toBeLessThanOrEqual(2);
      expect(await abertas(f.run)).toBe(1);
      vistos.add(`reuse=${t.reuse_count} rejeitados=${r.filter((x) => x.status === "rejected").length}`);
    }
    process.stderr.write(`[begin x2] ${JSON.stringify([...vistos])}\n`);
  });

  it("6 begin simultaneos: o contador nunca passa de 5 e ha no maximo 1 tentativa aberta (10 rodadas)", async () => {
    for (let i = 0; i < 10; i++) {
      const f = await fixture("ai_classify");
      const h1 = await f.begin();
      const r = await Promise.allSettled(Array.from({ length: 6 }, () => reentra(f)));
      for (const x of r)
        if (x.status === "rejected") expect(String(x.reason)).toMatch(/service_boundary_stale/);
      expect((await tentativa(h1.attempt_id)).reuse_count).toBeLessThanOrEqual(LIMITE);
      expect(await abertas(f.run)).toBeLessThanOrEqual(1);
    }
  });

  it("depois do limite o 1o job ligado a tentativa perde a tentativa (comportamento medido, ver stderr)", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    const j1 = await f.mkJob();
    await journal.attachJob(await f.scope(), h1, j1);
    for (let i = 0; i < LIMITE + 1; i++) await reentra(f);
    const t1 = await tentativa(h1.attempt_id);
    const fim = await journal.completeClassification(await f.scope(), j1, "quente").then(
      (v) => "ok:reused=" + v.reused,
      (e) => "erro:" + String(e).slice(0, 80),
    );
    process.stderr.write(`[job1 apos limite] tentativa1=${t1.status}; completeClassification(j1) => ${fim}\n`);
    expect(t1.status).toBe("failed");
  });
});

describe("migration 0708 sobre banco que ja tem tentativas", () => {
  const sql = readFileSync(
    "supabase/migrations/20261022090000_0708_execucoes_contador_de_reaproveitamento.sql",
    "utf8",
  );
  it("reaplicar e idempotente; tentativas existentes ficam em 0; check rejeita negativo (23514)", async () => {
    const f = await fixture("ai_classify");
    const h = await f.begin();
    await pool.query(sql);
    await pool.query(sql);
    expect((await tentativa(h.attempt_id)).reuse_count).toBe(0);
    const c = await pool.query(
      "select count(*)::int n from pg_constraint where conrelid='public.followup_execution_attempts'::regclass and conname='followup_execution_attempts_reuse_count_check'",
    );
    expect(c.rows[0].n).toBe(1);
    await expect(
      pool.query("update followup_execution_attempts set reuse_count=-1 where organization_id=$1 and id=$2", [
        GOV_ORG,
        h.attempt_id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("de uma tabela SEM a coluna (banco antigo) com linhas: a migration adiciona com default 0 e preserva as linhas (transacao revertida)", async () => {
    const f = await fixture("ai_classify");
    const h = await f.begin();
    const antes = Number((await pool.query("select count(*)::int n from followup_execution_attempts")).rows[0].n);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local lock_timeout='20s'");
      await c.query(
        "alter table followup_execution_attempts drop constraint if exists followup_execution_attempts_reuse_count_check",
      );
      await c.query("alter table followup_execution_attempts drop column reuse_count");
      await c.query(sql);
      const dep = await c.query(
        "select count(*)::int n, count(*) filter (where reuse_count=0)::int zeros from followup_execution_attempts",
      );
      expect(dep.rows[0].n).toBeGreaterThanOrEqual(antes);
      expect(dep.rows[0].zeros).toBe(dep.rows[0].n);
    } finally {
      await c.query("rollback");
      c.release();
    }
    expect((await tentativa(h.attempt_id)).reuse_count).toBe(0);
  });
});

describe("zeramento no attachJob: o que ele deixa de limitar e o ai_classify nao grava efeitos", () => {
  it("30 reentradas, cada uma ligando um job NOVO: mesma tentativa, contador 0, 30+ jobs ligados (sem teto alem da janela)", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    for (let i = 0; i < 30; i++) {
      const r = await reentra(f);
      if (r.kind !== "ready") throw new Error("expected_ready");
      expect(r.handle.attempt_id).toBe(h1.attempt_id);
      await journal.attachJob(await f.scope(), r.handle, await f.mkJob());
    }
    expect((await tentativa(h1.attempt_id)).reuse_count).toBe(0);
    const n = await pool.query(
      "select count(*)::int n from followup_execution_attempt_jobs where organization_id=$1 and attempt_id=$2",
      [GOV_ORG, h1.attempt_id],
    );
    process.stderr.write(`[attach x30] jobs ligados a mesma tentativa: ${n.rows[0].n}\n`);
    expect(n.rows[0].n).toBe(30);
  });

  it("estourar o limite no ai_classify NAO cai em 'unknown': nao ha efeito gravado antes da conclusao", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    for (let i = 0; i < LIMITE + 1; i++) await reentra(f);
    const ef = await pool.query(
      "select count(*)::int n from followup_execution_effects e join followup_execution_steps s on s.organization_id=e.organization_id and s.id=e.step_id where e.organization_id=$1 and s.enrollment_id=$2",
      [GOV_ORG, f.run],
    );
    expect(ef.rows[0].n).toBe(0);
    expect((await tentativa(h1.attempt_id)).status).toBe("failed");
  });
});

describe("teto de jobs ligados por tentativa (50): o laco do job veneno fecha", () => {
  it("jobs novos a cada reentrada: ate 49 reaproveitam a mesma tentativa; a 50a fecha e abre attempt_no 2; a 51a segue na nova", async () => {
    const f = await fixture("ai_classify");
    const h1 = await f.begin();
    await journal.attachJob(await f.scope(), h1, await f.mkJob());
    let atual = h1;
    let fechouEm = 0;
    for (let k = 1; k <= 51; k++) {
      const r = await reentra(f);
      if (r.kind !== "ready") throw new Error("expected_ready");
      if (fechouEm === 0 && r.handle.attempt_id !== h1.attempt_id) fechouEm = k;
      if (fechouEm === 0) expect(r.handle.attempt_id).toBe(h1.attempt_id);
      atual = r.handle;
      await journal.attachJob(await f.scope(), r.handle, await f.mkJob());
    }
    process.stderr.write(`[teto 50] tentativa 1 fechada na reentrada ${fechouEm}; attempt_no final ${atual.attempt_no}\n`);
    expect(fechouEm).toBe(50);
    expect(await tentativa(h1.attempt_id)).toMatchObject({ status: "failed", error_snapshot: { code: "execution_lease_interrupted" } });
    expect(atual.attempt_no).toBe(2);
    expect(await abertas(f.run)).toBe(1);
  });
});
