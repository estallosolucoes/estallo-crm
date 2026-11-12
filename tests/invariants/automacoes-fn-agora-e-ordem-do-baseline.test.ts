/**
 * fn_agora() (migration 0147) e a ordem dos blocos de automacao no baseline.
 *
 * PgExecutionJournal le o instante do banco com `select fn_agora()` dentro das
 * transacoes; se a funcao nao for executavel pelo papel do worker, todo "avanca
 * agora" quebra. E os blocos 0698/0704/0705 criam funcao, entao tem de ficar
 * ANTES da VARREDURA anon (0116).
 *
 * PAPEL DO WORKER (evidencia): lib/agent-engine/db/pool.ts abre o pool com
 * SUPABASE_DB_URL (Postgres direto, nunca service_role). Em local/VPS essa URL e
 * a `DB_URL` do Supabase (scripts/local-env.sh:108), isto e, o usuario `postgres`
 * (dono da funcao); o .env.example recomenda uma role de login dedicada
 * (`agent_worker`), que NAO existe no baseline. Conclusao: o worker em producao
 * e o dono `postgres`, que executa por ser dono; o pool de teste tambem e
 * `postgres`. `service_role` e a segunda via (PostgREST) e e checada abaixo.
 * Uma role dedicada precisaria de GRANT EXECUTE proprio: isso NAO esta medido.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

const podeExecutar = async (papel: string) =>
  (
    await pool.query<{ ok: boolean }>(
      "select has_function_privilege($1, 'public.fn_agora()', 'execute') as ok",
      [papel],
    )
  ).rows[0]!.ok;

describe("fn_agora() - permissoes", () => {
  it("existe", async () => {
    const r = await pool.query("select 1 from pg_proc where oid = 'public.fn_agora()'::regprocedure");
    expect(r.rowCount).toBe(1);
  });

  it("service_role e o papel de login do pool (worker) executam", async () => {
    expect(await podeExecutar("service_role")).toBe(true);
    const { rows } = await pool.query<{ u: string }>("select current_user as u");
    expect(rows[0]!.u).toBe("postgres");
    expect(await podeExecutar(rows[0]!.u)).toBe(true);
    // e executa de fato, pelo caminho que o journal usa
    expect((await pool.query("select fn_agora()")).rowCount).toBe(1);
  });

  it("anon, authenticated e PUBLIC NAO executam (revoke da 0147)", async () => {
    expect(await podeExecutar("anon")).toBe(false);
    expect(await podeExecutar("authenticated")).toBe(false);
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.fn_agora()'::regprocedure and a.grantee = 0`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe("fn_agora() - relogio", () => {
  it("nunca fica a frente de clock_timestamp() (20 chamadas)", async () => {
    const { rows } = await pool.query<{ a: boolean }>(
      `select (fn_agora() > clock_timestamp()) as a from generate_series(1, 20)`,
    );
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.a)).toEqual([]);
  });

  it("nunca fica atras de now() da transacao, nem congela entre transacoes", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query<{ atras: boolean; igual: boolean }>(
        `select fn_agora() < now() as atras, fn_agora() = now() as igual from generate_series(1, 20)`,
      );
      expect(rows.filter((r) => r.atras)).toEqual([]);
      // stable: dentro da transacao e o now() dela (contrato da 0147)
      expect(rows.every((r) => r.igual)).toBe(true);
      await c.query("select pg_sleep(0.05)");
      const d = await c.query<{ ok: boolean }>("select fn_agora() >= now() as ok");
      expect(d.rows[0]!.ok).toBe(true);
      await c.query("commit");
    } finally {
      c.release();
    }
    // transacao nova: avanca
    const a = (await pool.query<{ t: Date }>("select fn_agora() as t")).rows[0]!.t;
    await pool.query("select pg_sleep(0.02)");
    const b = (await pool.query<{ t: Date }>("select fn_agora() as t")).rows[0]!.t;
    expect(b.getTime()).toBeGreaterThan(a.getTime());
  });
});

describe("baseline.sql - ordem dos blocos de automacao", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const pos = (cab: string) => sql.lastIndexOf(cab);
  const linha = (i: number) => sql.slice(0, i).split("\n").length;

  const varredura = pos("-- ---- VARREDURA anon");

  it("os cabecalhos existem (guarda de vacuidade)", () => {
    for (const m of ["0698", "0703", "0704", "0705"]) {
      expect(pos(`(migration ${m}) ----`), `cabecalho ${m}`).toBeGreaterThan(-1);
    }
    expect(varredura).toBeGreaterThan(-1);
  });

  it("0698, 0704 e 0705 vem ANTES da varredura; 0703 (sem funcao) depois", () => {
    for (const m of ["0698", "0704", "0705"]) {
      expect(pos(`(migration ${m}) ----`), `migration ${m}`).toBeLessThan(varredura);
    }
    expect(pos("(migration 0703) ----")).toBeGreaterThan(varredura);
  });

  it("nenhuma funcao e criada depois da varredura (a divida do HEAD foi paga: 0660/0661 subiram)", () => {
    const re = /^[ \t]*create[ \t]+(?:or[ \t]+replace[ \t]+)?function[ \t]+(?:public\.)?(\w+)/gim;
    const depois = [...sql.matchAll(re)]
      .filter((m) => m.index > varredura)
      .map((m) => `${m[1]} (linha ${linha(m.index)})`);
    expect(depois).toEqual([]);
  });
});
