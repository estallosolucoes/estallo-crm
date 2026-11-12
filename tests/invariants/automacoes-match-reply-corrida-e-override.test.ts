import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
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
import { GOV_ORG, seedGov } from "./gov-helpers";

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

async function fixture(options: { saveTo?: boolean } = {}) {
  const contact = randomUUID(),
    run = randomUUID(),
    version = randomUUID(),
    flow = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')",
    [contact, GOV_ORG],
  );
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
          ...(options.saveTo ? { save_to: { kind: "contact_name" } } : {}),
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
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,execution_contract,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,1,'task','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
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
  return { run, scope, tick, responde, attempts, venceEspera, contact, conversation: origin.conversation_id };
}

import { aplicarRespostaInbound } from "@/lib/followup/engine";

const saida = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const [a] = await f.attempts();
  return a as { status: string; output_snapshot: { matched: boolean; branch_id: string; reply_message_id: string | null } | null } | undefined;
};
const inbound = async (f: Awaited<ReturnType<typeof fixture>>, body: string, sentAt: string) => {
  const id = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
     select $1::uuid,$2,c.id,c.channel_session_id,$3,'text','inbound','received',$4,$6::timestamptz,$1::text
     from conversations c where c.id=$5`,
    [id, GOV_ORG, f.contact, body, f.conversation, sentAt],
  );
  return id;
};

describe("match_reply de roteamento: corrida, duas respostas, override e empate", () => {
  // Era DEFEITO (texto e id em duas consultas). Corrigido: texto e id saem da MESMA linha, então a
  // mensagem que entra no meio da decisão é lida inteira, e o par gravado é sempre coerente.
  it("(a) resposta NOVA chega no meio da decisão: o id gravado é o da mensagem cujo texto decidiu o ramo", async () => {
    const f = await fixture();
    await f.tick();
    const msg1 = await f.responde("talvez depois");
    let msg2: string | undefined;
    const racedDeps = {
      ...deps,
      db: {
        ...adapter,
        loadLastInboundMessage: async (...a: Parameters<NonNullable<typeof adapter.loadLastInboundMessage>>) => {
          msg2 ??= await f.responde("sim");
          return adapter.loadLastInboundMessage!(...a);
        },
      } as typeof adapter,
    };
    await avancarEnrollmentAtivo(racedDeps, await f.scope());
    const s = await saida(f);
    process.stderr.write(`[corrida] ramo=${s?.output_snapshot?.branch_id} matched=${s?.output_snapshot?.matched} id=${s?.output_snapshot?.reply_message_id === msg1 ? "msg1" : s?.output_snapshot?.reply_message_id === msg2 ? "msg2" : "outro"}
`);
    const par = s?.output_snapshot;
    expect([msg1, msg2]).toContain(par?.reply_message_id);
    if (par?.reply_message_id === msg2) expect(par).toMatchObject({ matched: true, branch_id: "b_sim" });
    else expect(par).toMatchObject({ matched: false, branch_id: "else" });
  });

  it("(b1) duas respostas ANTES do tick (talvez, depois sim): vale a ultima e o id e o dela", async () => {
    const f = await fixture();
    await f.tick();
    await inbound(f, "talvez", new Date(Date.now() + 500).toISOString());
    const msg2 = await inbound(f, "sim", new Date(Date.now() + 900).toISOString());
    await f.tick();
    expect((await saida(f))?.output_snapshot).toMatchObject({ matched: true, branch_id: "b_sim", reply_message_id: msg2 });
  });

  it("(b2) 1a resposta nao casa e JA foi decidida (fallback); a 2a, que casaria, e ignorada: 1 tentativa, 1 passo, nada reabre", async () => {
    const f = await fixture();
    await f.tick();
    const msg1 = await f.responde("talvez");
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_else", steps_taken: 2 });
    await f.responde("sim");
    await f.tick();
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_else" });
    expect(await f.attempts()).toHaveLength(1);
    expect((await saida(f))?.output_snapshot?.reply_message_id).toBe(msg1);
  });

  it("(c1) aplicarRespostaInbound com override e a mensagem JA persistida: decide pelo override e grava o id dela", async () => {
    const f = await fixture();
    await f.tick();
    const msg = await f.responde("Sim");
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    expect(await f.scope()).toMatchObject({ current_node_id: "fim_sim", steps_taken: 2 });
    expect((await saida(f))?.output_snapshot).toMatchObject({ matched: true, reply_message_id: msg });
  });

  it("(c2) override com a mensagem AINDA NAO persistida (webhook adiantado): decide pelo texto; o id gravado e (medido)", async () => {
    const f = await fixture();
    await f.tick();
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = await saida(f);
    process.stderr.write(`[override sem mensagem] no=${(await f.scope()).current_node_id} saida=${JSON.stringify(s?.output_snapshot)}\n`);
    expect(s?.output_snapshot).toMatchObject({ matched: true, branch_id: "b_sim" });
    expect(s?.output_snapshot?.reply_message_id).toBeNull();
  });

  it("(c3) override com mensagem ANTIGA (anterior a espera) no banco e a nova ausente: o id nunca pode ser o da antiga", async () => {
    const f = await fixture();
    const antiga = await inbound(f, "sim", new Date(Date.now() - 3_600_000).toISOString());
    await f.tick();
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = await saida(f);
    process.stderr.write(`[override com antiga] saida=${JSON.stringify(s?.output_snapshot)} (antiga=${antiga})\n`);
    expect(s?.output_snapshot?.reply_message_id).not.toBe(antiga);
  });

  it("(e) duas mensagens com o MESMO sent_at: texto e id vem da mesma mensagem? (medido, 10 rodadas)", async () => {
    let divergiu = 0;
    for (let i = 0; i < 10; i++) {
      const f = await fixture();
      await f.tick();
      const quando = new Date(Date.now() + 700).toISOString();
      const m1 = await inbound(f, "talvez", quando);
      const m2 = await inbound(f, "sim", quando);
      await f.tick();
      const s = (await saida(f))?.output_snapshot;
      const idEsperado = s?.matched ? m2 : m1;
      if (s?.reply_message_id !== idEsperado) divergiu++;
    }
    process.stderr.write(`[empate de sent_at] divergencias texto x id: ${divergiu}/10\n`);
    expect(divergiu).toBe(0);
  });
});

describe("match_reply de roteamento: ticks concorrentes", () => {
  it("(1a) 2 e 3 ticks simultaneos sobre a mesma resposta: 1 tentativa, 1 passo, 1 ramo (10 rodadas)", async () => {
    for (const n of [2, 3]) {
      for (let i = 0; i < 10; i++) {
        const f = await fixture();
        await f.tick();
        await f.responde("sim");
        const sc = await f.scope();
        const r = await Promise.allSettled(Array.from({ length: n }, () => avancarEnrollmentAtivo(deps, sc)));
        for (const x of r) if (x.status === "rejected") expect(String(x.reason)).toMatch(/service_boundary_stale|stale/i);
        const at = await f.attempts();
        expect(at).toHaveLength(1);
        expect(at[0]).toMatchObject({ status: "succeeded", branch_id: "b_sim" });
        expect(await f.scope()).toMatchObject({ current_node_id: "fim_sim", steps_taken: 2 });
      }
    }
  });
});

describe("match_reply de roteamento: id x override (webhook) e releitura vazia", () => {
  it("(c4) override da msg1 ('Sim') com uma msg2 MAIS NOVA ja gravada: o id gravado deve ser o da msg1", async () => {
    const f = await fixture();
    await f.tick();
    const msg1 = await inbound(f, "Sim", new Date(Date.now() + 300).toISOString());
    const msg2 = await inbound(f, "talvez", new Date(Date.now() + 900).toISOString());
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = (await saida(f))?.output_snapshot;
    process.stderr.write(`[c4 override msg1, msg2 mais nova] ramo=${s?.branch_id} id=${s?.reply_message_id === msg1 ? "msg1" : s?.reply_message_id === msg2 ? "msg2(MAIS NOVA)" : String(s?.reply_message_id)}\n`);
    expect(s?.branch_id).toBe("b_sim");
    expect(s?.reply_message_id).toBe(msg1);
  });

  it("(c5) override da msg1 AINDA nao gravada, mas uma msg0 posterior a espera ja existe: o id nao pode ser o da msg0", async () => {
    const f = await fixture();
    await f.tick();
    const msg0 = await inbound(f, "oi", new Date(Date.now() + 300).toISOString());
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = (await saida(f))?.output_snapshot;
    process.stderr.write(`[c5 override sem msg1, msg0 existe] ramo=${s?.branch_id} id=${s?.reply_message_id === msg0 ? "msg0(OUTRA)" : String(s?.reply_message_id)}\n`);
    expect(s?.reply_message_id).not.toBe(msg0);
  });

  it("(c6) polling: msg1 'sim' lida; entre a 1a leitura e a releitura entra uma mensagem de corpo VAZIO (midia): o id nao pode ser o da midia", async () => {
    const f = await fixture();
    await f.tick();
    await f.responde("sim");
    let midia: string | undefined;
    const racedDeps = {
      ...deps,
      db: {
        ...adapter,
        loadLastInboundMessage: async (...a: Parameters<NonNullable<typeof adapter.loadLastInboundMessage>>) => {
          midia ??= await inbound(f, "", new Date(Date.now() + 800).toISOString());
          return adapter.loadLastInboundMessage!(...a);
        },
      } as typeof adapter,
    };
    await avancarEnrollmentAtivo(racedDeps, await f.scope());
    const s = (await saida(f))?.output_snapshot;
    process.stderr.write(`[c6 midia na releitura] ramo=${s?.branch_id} id=${s?.reply_message_id === midia ? "midia(OUTRA)" : String(s?.reply_message_id)}\n`);
    expect(s?.reply_message_id).not.toBe(midia);
  });
});

describe("match_reply de roteamento: id por texto, bordas de espaco", () => {
  it("(c7) override 'Sim' e mensagem gravada 'Sim\n' (quebra de linha no fim): decide pelo override e grava o id da mensagem", async () => {
    const f = await fixture();
    await f.tick();
    const m = await inbound(f, "Sim\n", new Date(Date.now() + 300).toISOString());
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = (await saida(f))?.output_snapshot;
    expect(s?.branch_id).toBe("b_sim");
    expect(s?.reply_message_id).toBe(m);
  });

  it("(c8) override 'Sim' e mensagem gravada ' Sim ' (espacos nas pontas): grava o id da mensagem", async () => {
    const f = await fixture();
    await f.tick();
    const m = await inbound(f, " Sim ", new Date(Date.now() + 300).toISOString());
    await aplicarRespostaInbound(deps, await f.scope(), "Sim");
    const s = (await saida(f))?.output_snapshot;
    expect(s?.branch_id).toBe("b_sim");
    expect(s?.reply_message_id).toBe(m);
  });
});
