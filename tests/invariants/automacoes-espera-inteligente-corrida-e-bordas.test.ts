import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aplicarRespostaInbound, avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { completeTurnForEnrollment, createPgAdminClient } from "@/lib/followup/turn-bridge";
import { MAX_PLAN_RECHECKS } from "@/lib/followup/node-handlers";
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
  max: 8,
});
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());

const MIN = 600_000;
const MAX = 1_800_000;

async function fixture(opts: { duasEsperas?: boolean } = {}) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const smart = (id: string, y: number) => ({
    id,
    type: "wait",
    label: id,
    position: { x: 0, y },
    config: { mode: "smart", min_ms: MIN, max_ms: MAX },
  });
  const fixo = {
    id: "fx",
    type: "wait",
    label: "fixo",
    position: { x: 0, y: 75 },
    config: { mode: "fixed", duration_ms: 3_600_000 },
  };
  const nodes = opts.duasEsperas
    ? [
        { id: "start", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        smart("w", 50),
        fixo,
        smart("w2", 100),
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 150 }, config: { outcome: "exhausted" } },
      ]
    : [
        { id: "start", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        smart("w", 50),
        { id: "end", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "exhausted" } },
      ];
  const edges = opts.duasEsperas
    ? [
        { id: "e1", source: "start", target: "w", condition: { type: "always" } },
        { id: "e2", source: "w", target: "fx", condition: { type: "always" } },
        { id: "e3", source: "fx", target: "w2", condition: { type: "always" } },
        { id: "e4", source: "w2", target: "end", condition: { type: "always" } },
      ]
    : [
        { id: "e1", source: "start", target: "w", condition: { type: "always" } },
        { id: "e2", source: "w", target: "end", condition: { type: "always" } },
      ];
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, GOV_ORG, { execution_contract: 1, nodes, edges }],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Espera ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,1,'start','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
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
  const tick = async () => avancarEnrollmentAtivo(deps, await scope());
  const vence = () =>
    pool.query(
      "update followup_enrollments set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  const claimDo = async (jobId: string) => {
    const locked = await pool.query(
      "update job_queue set status='running',locked_by='w-test',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
      [GOV_ORG, jobId],
    );
    return { worker_id: "w-test", acquired_at: locked.rows[0].locked_at as string };
  };
  const planejaCom = async (jobId: string, propostas: { node_id: string; aguardar_ms: number; motivo: string }[]) =>
    completeTurnForEnrollment(
      adapter,
      GOV_ORG,
      run,
      "start",
      { kind: "planned", propostas, modelo: "m" },
      undefined,
      jobId,
      await claimDo(jobId),
    );
  const planeja = (jobId: string, aguardar_ms: number) =>
    planejaCom(jobId, [{ node_id: "w", aguardar_ms, motivo: "teste" }]);
  const attempts = async (node: string) =>
    (
      await pool.query(
        `select a.id,a.status,a.output_snapshot,a.next_eval_at,s.status step_status,s.branch_id
         from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id=$3 order by a.attempt_no`,
        [GOV_ORG, run, node],
      )
    ).rows;
  const eventos = async (tipo: string) =>
    Number(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type=$3",
          [GOV_ORG, run, tipo],
        )
      ).rows[0].n,
    );
  return { run, contact, scope, tick, vence, planeja, planejaCom, attempts, eventos, jobs, deps, origin };
}

describe("espera smart: corrida entre o turno tardio (completePlan) e o plan_timeout", () => {
  it("(2a) 15 rodadas: exatamente 1 gatilho concluido, 1 desfecho (plano OU desistencia), nunca os dois, steps_taken=2", async () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const f = await fixture();
      await f.tick();
      for (let k = 0; k < MAX_PLAN_RECHECKS - 1; k++) {
        await f.vence();
        await f.tick();
      }
      await f.vence();
      const sc = await f.scope();
      const passosAntes = sc.steps_taken;
      const job = f.jobs[0]!;
      const claim = {
        worker_id: "w-test",
        acquired_at: (
          await pool.query(
            "update job_queue set status='running',locked_by='w-test',locked_at=now() where organization_id=$1 and id=$2 returning locked_at::text",
            [GOV_ORG, job],
          )
        ).rows[0].locked_at as string,
      };
      const r = await Promise.allSettled([
        completeTurnForEnrollment(
          adapter,
          GOV_ORG,
          f.run,
          "start",
          { kind: "planned", propostas: [{ node_id: "w", aguardar_ms: 900_000, motivo: "t" }], modelo: "m" },
          undefined,
          job,
          claim,
        ),
        avancarEnrollmentAtivo(f.deps, sc),
      ]);
      for (const x of r)
        if (x.status === "rejected")
          expect(String(x.reason), "so Stale/tardio e aceitavel").toMatch(/stale|not_linked|followup_job_stale|execution_/i);
      const s = await f.scope();
      const planejou = await f.eventos("timing_plan_decidido");
      const desistiu = Number((await pool.query("select count(*)::int n from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and node_id='start' and event_type='timing_plan_desistido'", [GOV_ORG, f.run])).rows[0].n);
      const start = await f.attempts("start");
      expect(start.filter((a) => a.status === "succeeded")).toHaveLength(1);
      expect(planejou + desistiu).toBeLessThanOrEqual(1);
      if (s.current_node_id !== "start") {
        expect(planejou + desistiu).toBe(1);
        expect(s.steps_taken).toBe(passosAntes + 1);
        expect(s.timing_plan === null).toBe(planejou === 0);
      }
      vistos.add(`no=${s.current_node_id} plano=${planejou} desistiu=${desistiu} passos=${passosAntes}->${s.steps_taken}`);
    }
    process.stderr.write(`[corrida plano x timeout] ${JSON.stringify([...vistos])}\n`);
  });

  it("(1a) o plan_timeout fecha a tentativa do plano (failed/lease interrompido) e conta no orcamento: attempt_no 2 conclui", async () => {
    const f = await fixture();
    await f.tick();
    for (let i = 0; i < MAX_PLAN_RECHECKS + 2 && (await f.scope()).current_node_id === "start"; i++) {
      await f.vence();
      await f.tick();
    }
    const start = await f.attempts("start");
    process.stderr.write(`[plan_timeout] tentativas do gatilho: ${JSON.stringify(start.map((a) => a.status))}\n`);
    expect(start.filter((a) => a.status === "succeeded")).toHaveLength(1);
    expect(start.length).toBeLessThanOrEqual(2);
  });
});

  // Era DEFEITO (o contrato 1 gravava `node_advanced`); corrigido no completeDecision.

describe("espera smart: duas esperas, resposta do contato e proposta invalida", () => {
  it("(2b) duas esperas smart no mesmo grafo (com uma fixa no meio): cada uma usa o seu instante do plano", async () => {
    const f = await fixture({ duasEsperas: true });
    await f.tick();
    await f.planejaCom(f.jobs[0]!, [
      { node_id: "w", aguardar_ms: 700_000, motivo: "a" },
      { node_id: "w2", aguardar_ms: 1_500_000, motivo: "b" },
    ]);
    const plano = (await f.scope()).timing_plan as { esperas: Record<string, { escolhido_ms: number }> };
    expect(Object.keys(plano.esperas).sort()).toEqual(["w", "w2"]);
    expect(plano.esperas.w!.escolhido_ms).toBe(700_000);
    expect(plano.esperas.w2!.escolhido_ms).toBe(1_500_000);

    const antes = Date.now();
    await f.tick();
    const [p1] = await f.attempts("w");
    expect(new Date(p1.next_eval_at).getTime() - antes).toBeGreaterThanOrEqual(700_000 - 5000);
    expect(new Date(p1.next_eval_at).getTime() - antes).toBeLessThanOrEqual(700_000 + 5000);
    await pool.query("update followup_execution_attempts set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2", [GOV_ORG, p1.id]);
    await f.tick(); // w -> fx
    await f.tick(); // fx estaciona
    const [fx] = await f.attempts("fx");
    await pool.query("update followup_execution_attempts set next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2", [GOV_ORG, fx.id]);
    await f.tick(); // fx -> w2
    const t0 = Date.now();
    await f.tick(); // w2 estaciona
    const [p2] = await f.attempts("w2");
    expect(p2).toMatchObject({ status: "waiting" });
    expect(new Date(p2.next_eval_at).getTime() - t0).toBeGreaterThanOrEqual(1_500_000 - 5000);
    expect(new Date(p2.next_eval_at).getTime() - t0).toBeLessThanOrEqual(1_500_000 + 5000);
  });

  it("(2c) resposta do contato DURANTE a espera smart: medido (acorda cedo ou segue esperando)", async () => {
    const f = await fixture();
    await f.tick();
    await f.planeja(f.jobs[0]!, 900_000);
    await f.tick();
    expect((await f.attempts("w"))[0]).toMatchObject({ status: "waiting" });
    await aplicarRespostaInbound(f.deps, await f.scope(), "oi, tudo bem?");
    const s = await f.scope();
    const w = await f.attempts("w");
    process.stderr.write(`[resposta na espera smart] no=${s.current_node_id} tentativas_w=${JSON.stringify(w.map((a) => [a.status, a.output_snapshot]))}\n`);
    expect(w).toHaveLength(1);
    expect(["w", "end"]).toContain(s.current_node_id);
  });

  it("(2d) proposta para no INEXISTENTE ou para no fora do plano (espera fixa): ignorada; o plano so tem esperas smart do grafo", async () => {
    const f = await fixture({ duasEsperas: true });
    await f.tick();
    await f.planejaCom(f.jobs[0]!, [
      { node_id: "fantasma", aguardar_ms: 1_000_000, motivo: "x" },
      { node_id: "fx", aguardar_ms: 1_000_000, motivo: "fixa" },
      { node_id: "w", aguardar_ms: 1_000_000, motivo: "ok" },
    ]);
    const s = await f.scope();
    const plano = s.timing_plan as { esperas: Record<string, { escolhido_ms: number }> };
    process.stderr.write(`[proposta invalida] esperas=${JSON.stringify(Object.keys(plano.esperas))}\n`);
    expect(Object.keys(plano.esperas)).not.toContain("fantasma");
    expect(Object.keys(plano.esperas)).not.toContain("fx");
    expect(s.current_node_id).toBe("w");
  });

  it("(2d2) so propostas invalidas: o plano nao quebra e o fluxo avanca (espera cai no padrao do no)", async () => {
    const f = await fixture();
    await f.tick();
    await f.planejaCom(f.jobs[0]!, [{ node_id: "fantasma", aguardar_ms: 1_000_000, motivo: "x" }]);
    const s = await f.scope();
    process.stderr.write(`[so invalidas] no=${s.current_node_id} plano=${JSON.stringify(s.timing_plan)}\n`);
    expect(s.current_node_id).toBe("w");
    expect((await f.attempts("start"))[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("espera smart: o plan_timeout precisa ser legivel na timeline", () => {
  it("(1d) plan_timeout no contrato 1 grava o evento timing_plan_desistido (nao so node_advanced)", async () => {
    const f = await fixture();
    await f.tick();
    for (let i = 0; i < MAX_PLAN_RECHECKS + 2 && (await f.scope()).current_node_id === "start"; i++) {
      await f.vence();
      await f.tick();
    }
    expect((await f.scope()).current_node_id).toBe("w");
    expect(await f.eventos("timing_plan_desistido")).toBe(1);
  });
});
