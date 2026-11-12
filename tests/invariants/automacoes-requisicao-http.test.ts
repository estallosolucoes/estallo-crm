import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rede = vi.hoisted(() => ({ chamada: vi.fn() }));
vi.mock(import("@/lib/followup/requisicao-http"), async (original) => ({
  ...(await original()),
  executarRequisicaoHttp: rede.chamada,
}));

import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * Requisição HTTP (Fase 5), motor novo e Postgres real. A rede é trocada por uma chamada falsa (a guarda anti-SSRF
 * recusaria o 127.0.0.1 de um servidor local); o que se prova é o DIÁRIO: intenção gravada antes da rede, recibo e
 * avanço só com 2xx, e resultado incerto nunca reenviado — inclusive quando o processo morre depois da intenção.
 */
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 4,
});
const adapter = createPgAdminClient(pool);
beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(() => rede.chamada.mockReset());

const deps = {
  db: adapter,
  clock: () => new Date(),
  enqueueJob: async () => {
    throw new Error("http_must_not_enqueue");
  },
};
const no = (id: string, type: string, config: object) => ({ id, type, label: id, position: { x: 0, y: 0 }, config });

async function conexao(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into automation_http_connections(id,organization_id,label,base_url,auth_kind,secret_encrypted,secret_iv,secret_tag,secret_last4)
     values($1,$2,$3,'https://api.exemplo.com','bearer','\\x01','\\x02','\\x03','-123')`,
    [id, GOV_ORG, `ERP ${id.slice(0, 6)}`],
  );
  return id;
}

async function execucao(connectionId: string) {
  const contact = randomUUID(),
    version = randomUUID(),
    flow = randomUUID(),
    run = randomUUID();
  await pool.query("insert into contacts(id,organization_id,name,display_name) values($1,$2,'Ana','Ana')", [contact, GOV_ORG]);
  const origin = await criarOrigemDeFollowup(pool, GOV_ORG, contact);
  const g = {
    execution_contract: 1,
    nodes: [
      no("http", "http_request", { connection_id: connectionId, metodo: "POST", caminho: "/pedidos", corpo: '{"origem":"crm"}' }),
      no("fim", "end", { outcome: "converted" }),
    ],
    edges: [{ id: "e1", source: "http", target: "fim", condition: { type: "always" } }],
  };
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)", [version, GOV_ORG, g]);
  await pool.query("insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,$4,'active',$3)", [flow, GOV_ORG, version, `HTTP ${run}`]);
  await pool.query(
    `insert into followup_enrollments
     (id,organization_id,pointer_id,version_id,contact_id,conversation_id,service_boundary,current_node_id,status,next_eval_at,claimed_until)
     values($1,$2,$3,$4,$5,$6,$7,'http','active',now()-interval '1 second',now()+interval '2 minutes')`,
    [run, GOV_ORG, flow, version, contact, origin.conversation_id, origin],
  );
  return run;
}

async function tick(run: string) {
  await pool.query("update followup_enrollments set next_eval_at=now()-interval '1 second', claimed_until=now()+interval '2 minutes' where id=$1", [run]);
  await avancarEnrollmentAtivo(deps, (await adapter.loadEnrollmentById(GOV_ORG, run))!);
}

async function estado(run: string) {
  const e = (await pool.query("select status,current_node_id,last_error from followup_enrollments where id=$1", [run])).rows[0];
  const passo = (
    await pool.query(
      `select s.status, a.output_snapshot, a.error_snapshot from followup_execution_steps s join followup_execution_attempts a on a.step_id=s.id
        where s.organization_id=$1 and s.enrollment_id=$2 and s.node_id='http' order by a.attempt_no desc limit 1`,
      [GOV_ORG, run],
    )
  ).rows[0];
  const efeitos = (
    await pool.query("select status,result_snapshot from followup_execution_effects where enrollment_id=$1 and operation='http_request'", [run])
  ).rows;
  return { e, passo, efeitos };
}

describe("requisição HTTP (motor novo, Postgres real)", () => {
  it("2xx: a intenção vira recibo, a saída fica no diário e o fluxo avança; o pedido não carrega segredo em claro", async () => {
    const con = await conexao();
    const run = await execucao(con);
    rede.chamada.mockImplementation(async () => {
      // No instante da rede a intenção já está gravada como `pending`.
      const pend = (await pool.query("select status from followup_execution_effects where enrollment_id=$1", [run])).rows;
      expect(pend).toEqual([{ status: "pending" }]);
      return { kind: "resposta", status: 201, corpo: { id: 42 }, truncado: false };
    });
    await tick(run);
    const pedido = rede.chamada.mock.calls[0]![0];
    expect(pedido).toMatchObject({ metodo: "POST", url: "https://api.exemplo.com/pedidos", corpo: { origem: "crm" } });
    expect(JSON.stringify(pedido)).not.toContain("-123");
    const { e, passo, efeitos } = await estado(run);
    expect(passo.status).toBe("succeeded");
    expect(passo.output_snapshot).toEqual({ status: 201, corpo: { id: 42 }, truncado: false });
    expect(efeitos).toEqual([{ status: "confirmed", result_snapshot: { status: 201, corpo: { id: 42 }, truncado: false } }]);
    expect(e.current_node_id).toBe("fim");
    const auditoria = (
      await pool.query("select metadata from api_audit_log where organization_id=$1 and action='automation.http_request_sent' and resource_id=$2", [GOV_ORG, con])
    ).rows;
    expect(auditoria[0]?.metadata).toMatchObject({ metodo: "POST", status: 201 });
  });

  it("resultado incerto (timeout) para a execução para revisão, sem nova tentativa", async () => {
    const run = await execucao(await conexao());
    rede.chamada.mockResolvedValue({ kind: "incerto", motivo: "timeout" });
    await tick(run);
    const { e, passo, efeitos } = await estado(run);
    expect(e.status).toBe("dead");
    expect(passo.status).toBe("unknown");
    expect(efeitos).toEqual([{ status: "unknown", result_snapshot: null }]);
    const aviso = (await pool.query("select 1 from agent_inbox_items where ref_id=$1 and kind='followup_dead'", [run])).rows;
    expect(aviso).toHaveLength(1);
  });

  it("o processo cair depois da intenção NUNCA reenvia: a próxima rodada vê a intenção sem desfecho e para", async () => {
    const run = await execucao(await conexao());
    rede.chamada.mockRejectedValueOnce(new Error("processo caiu no meio"));
    await tick(run);
    expect(rede.chamada).toHaveBeenCalledTimes(1);
    await tick(run);
    expect(rede.chamada).toHaveBeenCalledTimes(1);
    const { e, efeitos } = await estado(run);
    expect(e.status).toBe("dead");
    expect(efeitos.map((x) => x.status)).toEqual(["unknown"]);
  });

  it("não saiu (conexão recusada) tenta de novo, e a nova tentativa chama de novo", async () => {
    const run = await execucao(await conexao());
    rede.chamada
      .mockResolvedValueOnce({ kind: "nao_saiu", motivo: "ECONNREFUSED", bloqueado: false })
      .mockResolvedValueOnce({ kind: "resposta", status: 200, corpo: "ok", truncado: false });
    await tick(run);
    expect((await estado(run)).efeitos.map((x) => x.status)).toEqual(["failed"]);
    await tick(run);
    expect(rede.chamada).toHaveBeenCalledTimes(2);
    const { passo, efeitos } = await estado(run);
    expect(passo.status).toBe("succeeded");
    expect(efeitos.map((x) => x.status)).toEqual(["confirmed"]);
  });

  it("status 500 é falha conhecida, sem reenvio; conexão inexistente falha com explicação sem abrir rede", async () => {
    const run = await execucao(await conexao());
    rede.chamada.mockResolvedValue({ kind: "resposta", status: 500, corpo: null, truncado: false });
    await tick(run);
    const r = await estado(run);
    expect(r.e.status).toBe("dead");
    expect(r.passo.error_snapshot).toMatchObject({ code: "http_status_nao_aceito" });

    rede.chamada.mockReset();
    const outra = await execucao(randomUUID());
    await tick(outra);
    expect(rede.chamada).not.toHaveBeenCalled();
    expect((await estado(outra)).passo.error_snapshot?.message).toContain("não existe mais");
  });
});
