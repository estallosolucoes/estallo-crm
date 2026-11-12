import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { PgExecutionJournal } from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
import type * as ContractModule from "@/lib/followup/execution-contract";

// Mesma liberação dos demais invariantes do contrato 1: só a indisponibilidade é ignorada.
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
    throw new Error("fallback_erro_must_not_enqueue");
  },
};

/**
 * Fluxo: trigger → [tag] → fim_ok, com um bloco `edit_lead_tag` cuja execução FALHA de vez quando a
 * inscrição não tem lead explícito (`execution_lead_required`, erro de configuração: não adianta
 * tentar de novo). `comErro` liga a saída "Fallback erro" do bloco ao nó `socorro`.
 */
async function fixture(opts: { comErro: boolean }) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const no = (id: string, type: string, config: object, y: number) => ({
    id,
    type,
    label: id,
    position: { x: 0, y },
    config,
  });
  const graph = {
    execution_contract: 1,
    nodes: [
      no("tag", "edit_lead_tag", { tags: ["vip"] }, 0),
      no("fim_ok", "end", { outcome: "converted" }, 100),
      no("socorro", "end", { outcome: "custom" }, 100),
    ],
    edges: [
      { id: "e_ok", source: "tag", target: "fim_ok", condition: { type: "always" } },
      ...(opts.comErro
        ? [
            {
              id: "e_err",
              source: "tag",
              target: "socorro",
              condition: { type: "branch", branch_id: "on_error" },
            },
          ]
        : []),
    ],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [
    version,
    GOV_ORG,
    graph,
  ]);
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)",
    [flow, GOV_ORG, version, `Erro ${run}`],
  );
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until,lead_id)
     values($1,$2,$3,$4,$5,$6,$7,1,'tag','active',now()-interval '1 second',now()+interval '2 minutes',null)`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
  const reclama = () =>
    pool.query(
      "update followup_enrollments set claimed_until=now()+interval '2 minutes', next_eval_at=now()-interval '1 second' where organization_id=$1 and id=$2",
      [GOV_ORG, run],
    );
  const tick = async () => avancarEnrollmentAtivo(deps, await scope());
  const inscricao = async () =>
    (
      await pool.query(
        "select current_node_id,status,last_error,cancel_reason,outcome,steps_taken from followup_enrollments where organization_id=$1 and id=$2",
        [GOV_ORG, run],
      )
    ).rows[0] as {
      current_node_id: string;
      status: string;
      last_error: string | null;
      cancel_reason: string | null;
      outcome: string | null;
      steps_taken: number;
    };
  const eventos = async (tipo: string) =>
    (
      await pool.query(
        "select node_id,payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type=$3",
        [GOV_ORG, run, tipo],
      )
    ).rows as { node_id: string; payload: Record<string, unknown> }[];
  const avisos = async () =>
    Number(
      (
        await pool.query(
          "select count(*)::int n from agent_inbox_items where organization_id=$1 and kind='followup_dead' and ref_id=$2",
          [GOV_ORG, run],
        )
      ).rows[0].n,
    );
  const passo = async () =>
    (
      await pool.query(
        "select status,branch_id from followup_execution_steps where organization_id=$1 and enrollment_id=$2 and node_id='tag' order by visit desc limit 1",
        [GOV_ORG, run],
      )
    ).rows[0] as { status: string; branch_id: string | null };
  return { run, scope, reclama, tick, inscricao, eventos, avisos, passo };
}

describe("Fallback erro (saída de erro dos blocos no motor novo)", () => {
  it("falha definitiva COM a saída ligada: o fluxo continua por ela, sem parar e sem aviso na Central", async () => {
    const f = await fixture({ comErro: true });
    await f.tick();
    const depois = await f.inscricao();
    expect(depois.current_node_id).toBe("socorro");
    expect(depois.status).toBe("active");
    expect(depois.last_error).toBe("execution_lead_required");
    expect(await f.avisos()).toBe(0);
    expect(await f.passo()).toMatchObject({ status: "failed", branch_id: "on_error" });
    const eventos = await f.eventos("execution_error_routed");
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      node_id: "tag",
      payload: { code: "execution_lead_required", next_node_id: "socorro", branch_id: "on_error" },
    });
  });

  it("o fluxo realmente termina pelo caminho de erro (o nó de destino executa)", async () => {
    const f = await fixture({ comErro: true });
    await f.tick();
    await f.reclama();
    await f.tick();
    expect(await f.inscricao()).toMatchObject({ status: "completed", current_node_id: "socorro" });
  });

  it("falha definitiva SEM a saída ligada: continua parando a inscrição e avisando a Central (comportamento anterior)", async () => {
    const f = await fixture({ comErro: false });
    await f.tick();
    const depois = await f.inscricao();
    expect(depois.current_node_id).toBe("tag");
    expect(depois.status).toBe("dead");
    expect(await f.avisos()).toBe(1);
    expect(await f.eventos("execution_error_routed")).toHaveLength(0);
  });

  it("repetir o tick depois do desvio não desvia de novo nem duplica o evento", async () => {
    const f = await fixture({ comErro: true });
    await f.tick();
    await f.tick().catch(() => undefined);
    expect(await f.eventos("execution_error_routed")).toHaveLength(1);
  });

  it("resultado INCERTO (unknown) nunca desvia: para e avisa a Central, mesmo com a saída ligada", async () => {
    const f = await fixture({ comErro: true });
    const begun = await journal.begin(await f.scope(), { contact_id: "x" });
    if (begun.kind !== "ready") throw new Error("esperava ready");
    await journal.fail(await f.scope(), begun.handle, {
      code: "execution_send_outcome_unknown",
      message: "Não foi possível confirmar o resultado.",
      category: "unknown",
      retryable: false,
    });
    const depois = await f.inscricao();
    expect(depois.current_node_id).toBe("tag");
    expect(depois.status).toBe("dead");
    expect(await f.avisos()).toBe(1);
    expect(await f.eventos("execution_error_routed")).toHaveLength(0);
  });

  it("falha transitória tenta de novo primeiro; só ao esgotar as tentativas desvia pela saída de erro", async () => {
    const f = await fixture({ comErro: true });
    const max = Number(
      (
        await pool.query(
          "select max_attempts from followup_enrollments where organization_id=$1 and id=$2",
          [GOV_ORG, f.run],
        )
      ).rows[0].max_attempts,
    );
    const estados: string[] = [];
    for (let i = 0; i < max + 1; i++) {
      await f.reclama();
      const begun = await journal.begin(await f.scope(), { contact_id: "x" });
      if (begun.kind !== "ready") break;
      await journal.fail(await f.scope(), begun.handle, {
        code: "execution_tags_write_failed",
        message: "Falha transitória.",
        category: "transient",
        retryable: true,
      });
      estados.push((await f.inscricao()).current_node_id);
    }
    // `max` falhas ainda cabem no orçamento (ficam em "tag"); a seguinte esgota e desvia.
    expect(estados).toEqual(Array(max).fill("tag").concat(["socorro"]));
    expect(await f.avisos()).toBe(0);
    expect(await f.eventos("execution_error_routed")).toHaveLength(1);
  });
});
