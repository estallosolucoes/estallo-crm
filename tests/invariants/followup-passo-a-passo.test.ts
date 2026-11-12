import { criarOrigemDeFollowup } from "./followup-service-origin";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runFollowupTick, type FollowupJobRequest, type TickDeps } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * REEXECUÇÃO E PASSO A PASSO CONTRA POSTGRES DE VERDADE (migration 0714).
 *
 *  1. a coluna `passo_a_passo` existe, nasce falsa e o claim a devolve — sem isso o motor nunca saberia que a execução
 *     é conduzida à mão;
 *  2. o claim NÃO vê a execução pausada no próximo bloco (é o que a faz esperar a pessoa);
 *  3. o motor, pelo adapter pg de PRODUÇÃO, roda UM bloco por vez: concluir o bloco deixa a execução em
 *     `paused_manual` sem horário (o CHECK do relógio aceita), a espera do bloco `wait` não é cumprida, e o último
 *     bloco conclui a execução. A mesma execução SEM a marca anda como sempre (controle);
 *  4. a linha de reexecução (`source_enrollment_id` + `recovery_kind = 'restart'`, FK composta por contato) é aceita,
 *     o índice "um vivo por contato" segura a segunda enquanto a primeira vive, e libera quando ela termina.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});
afterAll(async () => {
  await pool.end();
});
const db = createPgAdminClient(pool);

const GRAFO: FlowGraph = {
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "w", type: "wait", label: "Espera", position: { x: 0, y: 100 }, config: { mode: "fixed", duration_ms: 86_400_000 } },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 200 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "e1", source: "t", target: "w", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "w", target: "f", priority: 0, condition: { type: "always" } },
  ],
} as unknown as FlowGraph;

interface Cenario {
  org: string;
  contactId: string;
  pointerId: string;
  versionId: string;
}

async function montaCenario(rotulo: string): Promise<Cenario> {
  const nome = `passo-${rotulo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows: orgRows } = await pool.query<{ id: string }>(
    `insert into organizations (slug, legal_name, display_name) values ($1, $2, $3) returning id`,
    [nome, nome, nome],
  );
  const org = orgRows[0]!.id;
  const { rows: contactRows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Cliente do passo a passo') returning id`,
    [org],
  );
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(GRAFO)],
  );
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id) values ($1, $2, 'active', $3) returning id`,
    [org, `Fluxo ${rotulo} ${Date.now()}-${Math.random()}`, versionRows[0]!.id],
  );
  return { org, contactId: contactRows[0]!.id, pointerId: pointerRows[0]!.id, versionId: versionRows[0]!.id };
}

async function criaExecucao(
  c: Cenario,
  o: {
    passoAPasso?: boolean;
    status?: string;
    node?: string;
    origem?: string;
    contactId?: string;
  } = {},
): Promise<string> {
  const contactId = o.contactId ?? c.contactId;
  const fronteira = await criarOrigemDeFollowup(pool, c.org, contactId);
  const status = o.status ?? "active";
  const comRelogio = status === "active" || status === "waiting_reply";
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at,
        conversation_id, service_boundary, passo_a_passo, source_enrollment_id, recovery_kind)
     values ($1, $2, $3, $4, $5, $6, case when $7 then now() - interval '1 second' else null end,
             $8, $9::jsonb, $10, $11, case when $11::uuid is null then null else 'restart' end)
     returning id`,
    [
      c.org,
      c.pointerId,
      c.versionId,
      contactId,
      o.node ?? "t",
      status,
      comRelogio,
      fronteira.conversation_id,
      JSON.stringify(fronteira),
      o.passoAPasso ?? false,
      o.origem ?? null,
    ],
  );
  return rows[0]!.id;
}

async function le(id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(`select * from followup_enrollments where id = $1`, [id]);
  return rows[0]!;
}

const deps = (jobs: FollowupJobRequest[] = []): TickDeps => ({
  db,
  clock: () => new Date(),
  enqueueJob: async (job) => void jobs.push(job),
});

/** O que «Executar próximo bloco» faz no banco: devolve ao relógio, agora. */
async function mandaExecutarOProximo(id: string): Promise<void> {
  await pool.query(
    `update followup_enrollments set status = 'active', next_eval_at = now() - interval '1 second', claimed_until = null where id = $1`,
    [id],
  );
}

describe("passo a passo — o banco", () => {
  it("a coluna existe, nasce falsa, e o claim a devolve", async () => {
    const c = await montaCenario("coluna");
    const comum = await criaExecucao(c);
    expect((await le(comum)).passo_a_passo).toBe(false);

    const { rows: outro } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Outro cliente') returning id`,
      [c.org],
    );
    const manual = await criaExecucao(c, { passoAPasso: true, contactId: outro[0]!.id });
    const reclamados = await db.claimDueEnrollments(50, 120);
    const achado = reclamados.find((e) => e.id === manual);
    expect(achado?.passo_a_passo).toBe(true);
    expect(reclamados.find((e) => e.id === comum)?.passo_a_passo).toBe(false);
  });

  it("execução pausada no próximo bloco não é reclamada pelo motor", async () => {
    const c = await montaCenario("claim");
    const pausada = await criaExecucao(c, { passoAPasso: true, status: "paused_manual" });
    const { rows: outro } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Vencido') returning id`,
      [c.org],
    );
    const vencida = await criaExecucao(c, { contactId: outro[0]!.id });
    const ids = (await db.claimDueEnrollments(50, 120)).map((e) => e.id);
    expect(ids).toContain(vencida); // controle positivo: o claim funciona
    expect(ids).not.toContain(pausada);
  });
});

describe("passo a passo — o motor, um bloco por vez", () => {
  it("cada «executar próximo» roda UM bloco e pausa no seguinte; a espera não é cumprida; o fim conclui", async () => {
    const c = await montaCenario("motor");
    const id = await criaExecucao(c, { passoAPasso: true });

    // 1) gatilho → pausa em «w»
    await runFollowupTick(deps());
    let e = await le(id);
    expect(e).toMatchObject({ current_node_id: "w", status: "paused_manual", next_eval_at: null, steps_taken: 1 });

    // Pausada: um tick a mais não faz nada.
    await runFollowupTick(deps());
    expect(await le(id)).toMatchObject({ current_node_id: "w", status: "paused_manual", steps_taken: 1 });

    // 2) executa «w» (a espera de 1 dia NÃO é cumprida) → pausa em «f»
    await mandaExecutarOProximo(id);
    await runFollowupTick(deps());
    e = await le(id);
    expect(e).toMatchObject({ current_node_id: "f", status: "paused_manual", next_eval_at: null, steps_taken: 2 });

    // 3) executa o fim → concluída
    await mandaExecutarOProximo(id);
    await runFollowupTick(deps());
    e = await le(id);
    expect(e).toMatchObject({ status: "completed", passo_a_passo: true });
    expect(e.completed_at).not.toBeNull();
  });

  it("controle: a MESMA execução sem a marca anda sozinha e a espera do bloco wait é de verdade", async () => {
    const c = await montaCenario("controle");
    const id = await criaExecucao(c);
    await runFollowupTick(deps());
    let e = await le(id);
    expect(e).toMatchObject({ current_node_id: "w", status: "active" });
    // próximo tick (o bloco wait entra na espera de 1 dia)
    await pool.query(`update followup_enrollments set next_eval_at = now() - interval '1 second' where id = $1`, [id]);
    await runFollowupTick(deps());
    e = await le(id);
    expect(e.current_node_id).toBe("w");
    expect(Date.parse(String(e.next_eval_at)) - Date.now()).toBeGreaterThan(60 * 60 * 1000);
  });

  it("«continuar automaticamente»: tirar a marca devolve a execução ao motor, que segue sozinho", async () => {
    const c = await montaCenario("continuar");
    const id = await criaExecucao(c, { passoAPasso: true });
    await runFollowupTick(deps()); // t → w, pausada
    await pool.query(
      `update followup_enrollments set passo_a_passo = false, status = 'active', next_eval_at = now() - interval '1 second', claimed_until = null where id = $1`,
      [id],
    );
    await runFollowupTick(deps()); // w entra na espera de verdade
    const e = await le(id);
    expect(e).toMatchObject({ current_node_id: "w", status: "active", passo_a_passo: false });
    expect(Date.parse(String(e.next_eval_at)) - Date.now()).toBeGreaterThan(60 * 60 * 1000);
  });
});

describe("reexecução — o vínculo no banco", () => {
  it("aceita a linha ligada à original, e o índice «um vivo por contato» segura a segunda até a primeira terminar", async () => {
    const c = await montaCenario("vinculo");
    const original = await criaExecucao(c, { status: "dead", node: "w" });
    await pool.query(`update followup_enrollments set completed_at = now() where id = $1`, [original]);

    const filha = await criaExecucao(c, { origem: original });
    expect(await le(filha)).toMatchObject({ source_enrollment_id: original, recovery_kind: "restart" });

    await expect(criaExecucao(c, { origem: original })).rejects.toThrow(/duplicate key|idx_followup_enrollments_one_live/i);

    await pool.query(`update followup_enrollments set status = 'dead', completed_at = now(), next_eval_at = null where id = $1`, [filha]);
    const outra = await criaExecucao(c, { origem: original });
    expect(outra).not.toBe(filha);
  });

  it("a original não é tocada pela reexecução", async () => {
    const c = await montaCenario("imutavel");
    const original = await criaExecucao(c, { status: "completed", node: "f" });
    const antes = await le(original);
    await criaExecucao(c, { origem: original, passoAPasso: true, status: "paused_manual" });
    const depois = await le(original);
    expect(depois.updated_at).toEqual(antes.updated_at);
    expect(depois.status).toBe("completed");
  });

  it("vínculo para execução de OUTRO contato é recusado pela FK composta", async () => {
    const c = await montaCenario("fk");
    const original = await criaExecucao(c, { status: "completed", node: "f" });
    const { rows: outro } = await pool.query<{ id: string }>(
      `insert into contacts (organization_id, display_name) values ($1, 'Outro') returning id`,
      [c.org],
    );
    await expect(criaExecucao(c, { origem: original, contactId: outro[0]!.id })).rejects.toThrow(/foreign key|followup_execution_source_fk/i);
  });
});
