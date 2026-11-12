import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lastLine, seedGov, sql } from "./gov-helpers";

const FN = "public.fn_publish_followup_flow_version(uuid,uuid,jsonb,uuid)";
const MIGRATION = readFileSync(
  "supabase/migrations/20261021150000_0707_publicacao_recusa_contrato_de_execucao.sql",
  "utf8",
);
const BASELINE = readFileSync("supabase/baseline.sql", "utf8");
const inicio = BASELINE.lastIndexOf(
  "-- ---- Publish refuses the new execution contract (migration 0707)",
);
const varredura = BASELINE.indexOf("-- ---- VARREDURA anon", inicio);
// O bloco termina no próximo cabeçalho do apêndice (blocos posteriores, como o da 0708, ficam fora).
const proximo = BASELINE.indexOf("\n-- ---- ", inicio + 1);
const BLOCO = BASELINE.slice(inicio, proximo + 1);

const acl = () =>
  sql(
    `select coalesce(proacl::text,'NULL')||'|'||prosecdef||'|'||coalesce(proconfig::text,'') from pg_proc where oid='${FN}'::regprocedure`,
  );
const privs = () =>
  ["public", "anon", "authenticated", "service_role"]
    .map((r) =>
      r === "public"
        ? lastLine(
            sql(
              `select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a where p.oid='${FN}'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')`,
            ),
          )
        : lastLine(sql(`select has_function_privilege('${r}','${FN}','execute')`)),
    )
    .join(",");
const strip = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

describe("0707 — ACL preservada, idempotência e ordem no baseline", () => {
  it("controle: bloco localizado, acima da varredura anon e igual (sem comentários) à migration", () => {
    seedGov();
    expect(inicio).toBeGreaterThan(0);
    expect(varredura).toBeGreaterThan(inicio);
    expect(BLOCO).toContain("execution_contract_unavailable");
    expect(strip(BLOCO)).toBe(strip(MIGRATION));
  });

  it("migration e bloco, aplicados 2x cada, deixam ACL/segurança/search_path idênticos; só service_role executa; PUBLIC não", () => {
    const antes = acl();
    const p0 = privs();
    expect(p0).toBe("f,f,f,t");
    sql(MIGRATION);
    sql(MIGRATION);
    sql(BLOCO);
    sql(BLOCO);
    expect(acl()).toBe(antes);
    expect(privs()).toBe(p0);
    expect(antes).toContain("|true|"); // security definer
    expect(antes).toContain("search_path=public");
  });

  it("auto-curativa: se a ACL derivou (grant a anon/PUBLIC), re-aplicar volta a fechar", () => {
    for (const texto of [MIGRATION, BLOCO]) {
      sql(`grant execute on function ${FN} to anon, public`);
      expect(privs()).not.toBe("f,f,f,t");
      sql(texto);
      expect(privs()).toBe("f,f,f,t");
    }
  });

  it("a guarda só olha a chave de topo (chave aninhada não é recusada; nós têm seus próprios campos)", () => {
    seedGov();
    const org = "cccccccc-0000-4000-8000-000000000001";
    const ptr = "cccccccc-0707-4000-8000-000000000001";
    sql(
      `insert into public.followup_flow_pointers (id, organization_id, name, status) values ('${ptr}','${org}','p','draft') on conflict do nothing`,
    );
    const out = lastLine(
      sql(
        `select fn_publish_followup_flow_version('${org}','${ptr}','{"nodes":[{"execution_contract":1}],"edges":[]}'::jsonb,null)`,
      ),
    );
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
  });
});
