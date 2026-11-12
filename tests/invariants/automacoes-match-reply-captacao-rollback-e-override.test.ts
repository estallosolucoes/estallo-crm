import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aplicarRespostaInbound, avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";
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
  const tick = async () => avancarEnrollmentAtivo(deps, await scope());
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
    responde,
    attempts,
    venceEspera,
    contato,
    camposDoLead,
    lead,
    leadNovo,
  };
}




const nomeDoContato = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.contato()).name;

describe("captacao do match_reply: rollback, override, corrida", () => {
  it("(2a) falha FORCADA depois da gravacao e antes do commit (trigger no evento de avanco): rollback total e o retry grava uma vez", async () => {
    const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "overwrite" });
    await f.tick();
    await f.responde("Maria Souza");
    const nome = `zz_falha_${f.run.replaceAll("-", "")}`;
    await pool.query(
      `create or replace function ${nome}() returns trigger language plpgsql as $$ begin raise exception 'falha_forcada_apos_captacao'; end $$`,
    );
    await pool.query(
      `create trigger ${nome} before insert on followup_enrollment_events for each row
       when (NEW.enrollment_id = '${f.run}' and NEW.event_type = 'node_advanced') execute function ${nome}()`,
    );
    try {
      await f.tick();
      expect(await nomeDoContato(f)).toBe("Ana");
      expect(await f.scope()).toMatchObject({ current_node_id: "task", steps_taken: 1 });
      expect((await f.attempts()).some((a) => a.status === "succeeded")).toBe(false);
    } finally {
      await pool.query(`drop trigger if exists ${nome} on followup_enrollment_events`);
      await pool.query(`drop function if exists ${nome}()`);
    }
    // Sem a falha, o tick seguinte conclui e grava exatamente uma vez.
    for (let i = 0; i < 3 && (await f.scope()).current_node_id === "task"; i++) {
      await pool.query("update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2", [GOV_ORG, f.run]);
      await f.tick();
    }
    expect(await nomeDoContato(f)).toBe("Maria Souza");
    expect((await f.scope()).current_node_id).not.toBe("task");
  });

  it("(2d) override do webhook com a mensagem gravada: grava o texto do override", async () => {
    const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "overwrite" });
    await f.tick();
    await f.responde("Maria Souza");
    await aplicarRespostaInbound(deps, await f.scope(), "Maria Souza");
    expect(await nomeDoContato(f)).toBe("Maria Souza");
  });

  it("(2d2) override = body_preview (left(body,280)) de uma resposta LONGA: o campo deve receber o texto COMPLETO da mensagem, nao o preview truncado", async () => {
    const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "overwrite" });
    await f.tick();
    const longo = "Maria ".repeat(80).trim(); // 479 caracteres
    await f.responde(longo);
    await aplicarRespostaInbound(deps, await f.scope(), longo.slice(0, 280));
    const gravado = (await nomeDoContato(f)) ?? "";
    process.stderr.write(`[override longo] gravado=${gravado.length} chars (mensagem=${longo.length})\n`);
    expect(gravado).toBe(longo);
  });

  it("(2c) 2 e 3 ticks simultaneos com captacao: grava uma vez, 1 tentativa, 1 passo (10 rodadas)", async () => {
    for (const n of [2, 3]) {
      for (let i = 0; i < 10; i++) {
        const f = await fixture({ saveTo: { kind: "contact_custom", key: "apelido" }, ifExists: "overwrite" });
        await f.tick();
        await f.responde("Duda");
        const sc = await f.scope();
        const r = await Promise.allSettled(Array.from({ length: n }, () => avancarEnrollmentAtivo(deps, sc)));
        for (const x of r) if (x.status === "rejected") expect(String(x.reason)).toMatch(/stale|execution_/i);
        expect((await f.contato()).custom_fields).toMatchObject({ apelido: "Duda" });
        expect(await f.attempts()).toHaveLength(1);
        expect((await f.attempts())[0]).toMatchObject({ status: "succeeded" });
        expect((await f.scope()).steps_taken).toBe(2);
      }
    }
  });

  it("(2c2) duas respostas seguidas com captacao (a 1a decide e grava; a 2a, depois do avanco, nao regrava o campo)", async () => {
    const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "overwrite" });
    await f.tick();
    await f.responde("Primeira");
    await f.tick();
    await f.responde("Segunda");
    await f.tick();
    expect(await nomeDoContato(f)).toBe("Primeira");
  });

  it("resposta vazia (so espacos) nao grava nem decide pela captacao", async () => {
    const f = await fixture({ saveTo: { kind: "contact_name" }, ifExists: "overwrite" });
    await f.tick();
    await f.responde("   ");
    await f.tick();
    expect(await nomeDoContato(f)).toBe("Ana");
    expect((await f.scope()).current_node_id).toBe("task");
  });
});

describe("captacao do match_reply: {{volta}} com repeat real", () => {
  it("(2b) repeat de 2 voltas: a 1a resposta grava item_1 e a 2a grava item_2 (cada uma no seu campo)", async () => {
    const contact = randomUUID(),
      run = randomUUID(),
      version = randomUUID(),
      flow = randomUUID();
    await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
    const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
    const graph = {
      execution_contract: 1,
      nodes: [
        { id: "rep", type: "repeat", label: "Repete", position: { x: 0, y: 0 }, config: { max_count: 5 } },
        {
          id: "task",
          type: "match_reply",
          label: "Item",
          position: { x: 0, y: 50 },
          config: {
            branches: [{ id: "b_sim", label: "Sim", op: "eq", pattern: "zzz" }],
            grace_timeout_ms: 900_000,
            save_to: { kind: "contact_custom", key: "item_{{volta}}" },
            if_exists: "overwrite",
          },
        },
        { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
        { id: "fim_nr", type: "end", label: "NR", position: { x: 0, y: 100 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e_body", source: "rep", target: "task", condition: { type: "branch", branch_id: "body" } },
        { id: "e_done", source: "rep", target: "fim", condition: { type: "branch", branch_id: "done" } },
        { id: "e_nr", source: "task", target: "fim_nr", condition: { type: "branch", branch_id: "no_reply" } },
        { id: "e_back", source: "task", target: "rep", condition: { type: "always" } },
      ],
    };
    await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, graph]);
    await pool.query("insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)", [flow, GOV_ORG, version, `Volta ${run}`]);
    await pool.query(
      `insert into followup_enrollments
       (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
       values($1,$2,$3,$4,$5,$6,$7,1,'rep','active',now()-interval '1 second',now()+interval '2 minutes')`,
      [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
    );
    const scope = async () => (await adapter.loadEnrollmentById(GOV_ORG, run))!;
    const tick = async () => avancarEnrollmentAtivo(deps, await scope());
    const msg = async (body: string) =>
      pool.query(
        `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
         select gen_random_uuid(),$1,c.id,c.channel_session_id,$2,'text','inbound','received',$3,clock_timestamp(),gen_random_uuid()::text
         from conversations c where c.id=$4`,
        [GOV_ORG, contact, body, origin.conversation_id],
      );
    const campos = async () =>
      ((await pool.query("select custom_fields from contacts where organization_id=$1 and id=$2", [GOV_ORG, contact])).rows[0].custom_fields ?? {}) as Record<string, unknown>;
    const trilha: string[] = [];
    await msg("2"); // quantas voltas
    for (let i = 0; i < 12; i++) {
      const sc = await scope();
      trilha.push(`${sc.current_node_id}/${sc.status}`);
      if (sc.current_node_id === "task" && sc.status === "waiting_reply") {
        const feitos = Object.keys(await campos()).filter((k) => k.startsWith("item_")).length;
        await new Promise((r) => setTimeout(r, 15));
        await msg(feitos === 0 ? "Banana" : "Maca");
      }
      if (["completed", "dead", "cancelled"].includes(sc.status)) break;
      await pool.query("update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where organization_id=$1 and id=$2 and status<>'completed'", [GOV_ORG, run]);
      await tick();
    }
    process.stderr.write(`[volta] trilha=${trilha.join(" > ")} campos=${JSON.stringify(await campos())}\n`);
    expect(await campos()).toMatchObject({ item_1: "Banana", item_2: "Maca" });
  });
});
