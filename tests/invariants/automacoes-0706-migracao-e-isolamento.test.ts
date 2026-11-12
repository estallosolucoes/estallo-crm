import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const T = "public.followup_execution_attempt_jobs";
const MIGRATION = readFileSync(
  "supabase/migrations/20261021140000_0706_execucoes_varios_jobs_por_tentativa.sql",
  "utf8",
);
const BASELINE = readFileSync("supabase/baseline.sql", "utf8");
// Última definição do bloco 0706 no apêndice do baseline (rfind, nunca find).
const inicio = BASELINE.lastIndexOf(
  "-- ---- Execution attempts with several queue jobs (migration 0706)",
);
const fim = BASELINE.indexOf("\n-- ---- ", inicio + 10);
const APENDICE = BASELINE.slice(inicio, fim);

const ORG_B = randomUUID();
const MANAGER_B = randomUUID();
const DUAL = randomUUID(); // manager em A, viewer em B
const CONTACT_B = randomUUID();

// dois pares (A e B) de tentativa+job, e uma tentativa de A com job_id preenchido pela 0705
const ids = {
  verA: randomUUID(),
  verB: randomUUID(),
  flowA: randomUUID(),
  flowB: randomUUID(),
  runA: randomUUID(),
  runB: randomUUID(),
  stepA: randomUUID(),
  stepB: randomUUID(),
  attA: randomUUID(),
  attB: randomUUID(),
  attA2: randomUUID(),
  stepA2: randomUUID(),
  jobA: randomUUID(),
  jobB: randomUUID(),
  jobA2: randomUUID(),
};

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_B}', 'o706-b', 'B', 'B');
    insert into auth.users (id, email) values ('${MANAGER_B}', 'o706-mb@invariant.test'), ('${DUAL}', 'o706-dual@invariant.test');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_B}', '${ORG_B}', 'manager', now()),
      ('${DUAL}', '${GOV_ORG}', 'manager', now()),
      ('${DUAL}', '${ORG_B}', 'viewer', now());
    insert into public.contacts (id, organization_id, display_name) values ('${CONTACT_B}', '${ORG_B}', 'B');
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${ids.verA}', '${GOV_ORG}', '{}'::jsonb), ('${ids.verB}', '${ORG_B}', '{}'::jsonb);
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id) values
      ('${ids.flowA}', '${GOV_ORG}', 'A', 'active', '${ids.verA}'), ('${ids.flowB}', '${ORG_B}', 'B', 'active', '${ids.verB}');
    insert into public.followup_enrollments (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status) values
      ('${ids.runA}', '${GOV_ORG}', '${ids.flowA}', '${ids.verA}', '${GOV_CONTACT_1}', 'task', 'paused_manual'),
      ('${ids.runB}', '${ORG_B}', '${ids.flowB}', '${ids.verB}', '${CONTACT_B}', 'task', 'paused_manual');
    insert into public.followup_execution_steps (id, organization_id, enrollment_id, node_id, visit) values
      ('${ids.stepA}', '${GOV_ORG}', '${ids.runA}', 'task', 0), ('${ids.stepB}', '${ORG_B}', '${ids.runB}', 'task', 0),
      ('${ids.stepA2}', '${GOV_ORG}', '${ids.runA}', 'other', 0);
    insert into public.job_queue (id, organization_id, contact_id, kind, payload) values
      ('${ids.jobA}', '${GOV_ORG}', '${GOV_CONTACT_1}', 'followup_turn', '{}'::jsonb),
      ('${ids.jobB}', '${ORG_B}', '${CONTACT_B}', 'followup_turn', '{}'::jsonb),
      ('${ids.jobA2}', '${GOV_ORG}', '${GOV_CONTACT_1}', 'followup_turn', '{}'::jsonb);
    insert into public.followup_execution_attempts (id, organization_id, step_id, attempt_no, status, input_snapshot, job_id) values
      ('${ids.attA}', '${GOV_ORG}', '${ids.stepA}', 1, 'running', '{}'::jsonb, '${ids.jobA}'),
      ('${ids.attB}', '${ORG_B}', '${ids.stepB}', 1, 'running', '{}'::jsonb, '${ids.jobB}'),
      ('${ids.attA2}', '${GOV_ORG}', '${ids.stepA2}', 1, 'running', '{}'::jsonb, null);
  `);
});

const count = () => Number(lastLine(sql(`select count(*) from ${T}`)));
const pares = () =>
  sql(`select organization_id||':'||attempt_id||':'||job_id from ${T} order by 1`)
    .split("\n")
    .filter(Boolean);
const drop = () => sql(`drop table if exists ${T}`);
const fingerprint = () =>
  sql(`
    select 'priv:'||grantee||':'||privilege_type from information_schema.role_table_grants
      where table_schema='public' and table_name='followup_execution_attempt_jobs' order by 1;
    select 'pol:'||policyname||':'||cmd||':'||roles::text||':'||qual from pg_policies
      where schemaname='public' and tablename='followup_execution_attempt_jobs' order by 1;
    select 'idx:'||indexname from pg_indexes where schemaname='public' and tablename='followup_execution_attempt_jobs' order by 1;
    select 'rls:'||relrowsecurity||relforcerowsecurity from pg_class where oid='${T}'::regclass;
  `);

describe("0706 — migration sozinha e apêndice do baseline (Postgres real)", () => {
  it("controle: o baseline instalado já criou a tabela e o apêndice foi localizado", () => {
    expect(APENDICE.length).toBeGreaterThan(500);
    expect(APENDICE).toContain("followup_execution_attempt_jobs");
    expect(MIGRATION).toContain("followup_execution_attempt_jobs");
  });

  it("o corpo executável da migration e o do apêndice são o mesmo (sem comentários)", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
    expect(strip(APENDICE)).toBe(strip(MIGRATION));
  });

  it.each([
    ["migration", () => MIGRATION],
    ["apêndice do baseline", () => APENDICE],
  ])(
    "%s aplicada SOZINHA sobre o schema anterior (sem a tabela), duas vezes: backfill preserva o vínculo, sem duplicar",
    (_nome, texto) => {
      drop();
      expect(() => sql(`select count(*) from ${T}`)).toThrow();
      sql(texto());
      expect(pares()).toEqual(
        [`${GOV_ORG}:${ids.attA}:${ids.jobA}`, `${ORG_B}:${ids.attB}:${ids.jobB}`].sort(),
      );
      const antes = fingerprint();
      sql(texto());
      sql(texto());
      expect(count()).toBe(2);
      expect(fingerprint()).toBe(antes);
    },
  );

  it("re-aplicação preserva vínculos extras (2º job) e NÃO recria vínculo de job apagado pela retenção", () => {
    sql(
      `insert into ${T}(organization_id,attempt_id,job_id) values ('${GOV_ORG}','${ids.attA}','${ids.jobA2}')`,
    );
    sql(MIGRATION);
    expect(count()).toBe(3);
    // retenção da fila apaga o job: o vínculo some junto (cascade) e o histórico da tentativa fica
    sql(`delete from public.job_queue where id='${ids.jobA2}'`);
    expect(count()).toBe(2);
    sql(MIGRATION);
    expect(count()).toBe(2);
    expect(
      lastLine(sql(`select status from public.followup_execution_attempts where id='${ids.attA}'`)),
    ).toBe("running");
  });

  it("auto-curativa: grant e policy adulterados voltam ao desenho ao re-aplicar (migration e apêndice)", () => {
    for (const texto of [MIGRATION, APENDICE]) {
      const certo = fingerprint();
      sql(`grant all on ${T} to anon, authenticated; drop policy followup_execution_attempt_jobs_select on ${T};
           create policy followup_execution_attempt_jobs_select on ${T} for select to authenticated using (true);
           drop index public.followup_execution_attempt_jobs_job_idx;`);
      expect(fingerprint()).not.toBe(certo);
      sql(texto);
      expect(fingerprint()).toBe(certo);
    }
  });

  it("privilégios: anon nada; authenticated só SELECT; service_role escreve; nenhuma função nova exposta", () => {
    const priv = (role: string, p: string) =>
      lastLine(sql(`select has_table_privilege('${role}','${T}','${p}')`)) === "t";
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
      expect(priv("anon", p), `anon ${p}`).toBe(false);
    expect(priv("authenticated", "SELECT")).toBe(true);
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
      expect(priv("authenticated", p), `authenticated ${p}`).toBe(false);
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      expect(priv("service_role", p)).toBe(true);
    expect(() => sql(`set role anon; select count(*) from ${T}`)).toThrow(/permission denied/i);
  });

  it("a restrição não pode ser burlada: PK impede repetir o par, FK composta impede cruzar organizações, cascade cobre tentativa e job", () => {
    expect(() =>
      sql(
        `insert into ${T}(organization_id,attempt_id,job_id) values ('${GOV_ORG}','${ids.attA}','${ids.jobA}')`,
      ),
    ).toThrow(/duplicate key/);
    expect(() =>
      sql(
        `insert into ${T}(organization_id,attempt_id,job_id) values ('${GOV_ORG}','${ids.attB}','${ids.jobA}')`,
      ),
    ).toThrow(/foreign key/);
    expect(() =>
      sql(
        `insert into ${T}(organization_id,attempt_id,job_id) values ('${ORG_B}','${ids.attB}','${ids.jobA}')`,
      ),
    ).toThrow(/foreign key/);
    sql(
      `insert into ${T}(organization_id,attempt_id,job_id) values ('${GOV_ORG}','${ids.attA2}','${ids.jobA}')`,
    );
    sql(`delete from public.followup_execution_attempts where id='${ids.attA2}'`);
    expect(pares().filter((p) => p.includes(ids.attA2))).toEqual([]);
    expect(lastLine(sql(`select count(*) from public.job_queue where id='${ids.jobA}'`))).toBe("1");
  });
});

describe("0706 — isolamento entre organizações e papéis", () => {
  it("2 organizações: A não lê B e vice-versa; viewer/agent não leem; usuário em duas orgs só vê onde é manager", () => {
    sql(MIGRATION); // garante o estado
    expect(countAs(GOV_MANAGER, `select count(*) from ${T} where organization_id='${ORG_B}'`)).toBe(
      0,
    );
    expect(countAs(MANAGER_B, `select count(*) from ${T} where organization_id='${GOV_ORG}'`)).toBe(
      0,
    );
    expect(
      countAs(GOV_MANAGER, `select count(*) from ${T} where organization_id='${GOV_ORG}'`),
    ).toBeGreaterThan(0);
    expect(countAs(MANAGER_B, `select count(*) from ${T} where organization_id='${ORG_B}'`)).toBe(
      1,
    );
    for (const u of [GOV_VIEWER, GOV_AGENT_A])
      expect(countAs(u, `select count(*) from ${T}`)).toBe(0);
    // DUAL: manager em A (vê A), viewer em B (NÃO vê B)
    expect(
      countAs(DUAL, `select count(*) from ${T} where organization_id='${GOV_ORG}'`),
    ).toBeGreaterThan(0);
    expect(countAs(DUAL, `select count(*) from ${T} where organization_id='${ORG_B}'`)).toBe(0);
    // sem JWT (auth.uid() nulo): nada
    expect(
      Number(
        lastLine(
          sql(
            `set role authenticated; select set_config('request.jwt.claims','{}',false); select count(*) from ${T}`,
          ),
        ),
      ),
    ).toBe(0);
  });

  it("escrita pela sessão é negada em todos os verbos, inclusive para admin/manager e com organization_id forjado", () => {
    for (const u of [GOV_MANAGER, MANAGER_B, DUAL]) {
      expect(() =>
        writeCountAs(
          u,
          `insert into ${T}(organization_id,attempt_id,job_id) values ('${ORG_B}','${ids.attB}','${ids.jobB}')`,
        ),
      ).toThrow(/permission denied/i);
      expect(() => writeCountAs(u, `update ${T} set created_at=now()`)).toThrow(
        /permission denied/i,
      );
      expect(() => writeCountAs(u, `delete from ${T}`)).toThrow(/permission denied/i);
    }
    expect(() => sql(`set role authenticated; truncate ${T}`)).toThrow(/permission denied/i);
  });

  it("service_role sem filtro NÃO consegue ligar job de outra organização (FK composta) mesmo forjando organization_id", () => {
    expect(() =>
      sql(
        `set role service_role; insert into ${T}(organization_id,attempt_id,job_id) values ('${ORG_B}','${ids.attA}','${ids.jobB}')`,
      ),
    ).toThrow(/foreign key/);
    expect(() =>
      sql(
        `set role service_role; insert into ${T}(organization_id,attempt_id,job_id) values ('${GOV_ORG}','${ids.attB}','${ids.jobB}')`,
      ),
    ).toThrow(/foreign key/);
  });
});

describe("0706 — retenção e LGPD", () => {
  it("a tabela guarda só ids/timestamp (sem coluna de texto livre ou jsonb)", () => {
    const cols = sql(
      `select column_name||':'||data_type from information_schema.columns where table_schema='public' and table_name='followup_execution_attempt_jobs' order by 1`,
    ).split("\n");
    expect(cols).toEqual([
      "attempt_id:uuid",
      "created_at:timestamp with time zone",
      "job_id:uuid",
      "organization_id:uuid",
    ]);
  });

  it("anonimizar o contato NÃO apaga o vínculo (diário preservado); redigir payloads não toca na tabela", () => {
    const antes = count();
    sql(
      `update public.contacts set is_anonymized=true, anonymized_at=now() where organization_id='${GOV_ORG}' and id='${GOV_CONTACT_1}'`,
    );
    expect(count()).toBe(antes);
    sql(`select public.fn_redigir_payloads_execucao('${GOV_ORG}','${ids.runA}')`);
    expect(count()).toBe(antes);
  });

  it("apagar a execução (retenção de metadados) leva os vínculos junto e NÃO apaga a fila nem outras organizações", () => {
    const antesB = pares().filter((p) => p.startsWith(ORG_B)).length;
    sql(
      `delete from public.followup_enrollments where organization_id='${GOV_ORG}' and id='${ids.runA}'`,
    );
    expect(pares().filter((p) => p.startsWith(GOV_ORG))).toEqual([]);
    expect(pares().filter((p) => p.startsWith(ORG_B)).length).toBe(antesB);
    expect(
      lastLine(
        sql(`select count(*) from public.job_queue where id in ('${ids.jobA}','${ids.jobB}')`),
      ),
    ).toBe("2");
  });

  it("apagar o contato (hard delete) não deixa vínculo órfão", () => {
    sql(`delete from public.contacts where organization_id='${ORG_B}' and id='${CONTACT_B}'`);
    const orfaos = lastLine(
      sql(
        `select count(*) from ${T} j where not exists (select 1 from public.followup_execution_attempts a where a.organization_id=j.organization_id and a.id=j.attempt_id)`,
      ),
    );
    expect(orfaos).toBe("0");
  });
});
