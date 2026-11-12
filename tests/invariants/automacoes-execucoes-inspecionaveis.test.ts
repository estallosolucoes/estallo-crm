import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const ORG_B = "dddddddd-0698-4000-8000-000000000001";
const CONTACT_B = "dddddddd-0698-4000-8000-000000000002";
const VERSION_A = "dddddddd-0698-4000-8000-000000000003";
const VERSION_B = "dddddddd-0698-4000-8000-000000000004";
const FLOW_A = "dddddddd-0698-4000-8000-000000000005";
const FLOW_B = "dddddddd-0698-4000-8000-000000000006";
const RUN_A = "dddddddd-0698-4000-8000-000000000007";
const RUN_B = "dddddddd-0698-4000-8000-000000000008";
const STEP_A = "dddddddd-0698-4000-8000-000000000009";
const STEP_B = "dddddddd-0698-4000-8000-00000000000a";
const ATTEMPT_A = "dddddddd-0698-4000-8000-00000000000b";
const EFFECT_A = "dddddddd-0698-4000-8000-00000000000c";
const RUN_A2 = "dddddddd-0698-4000-8000-00000000000d";
const ATTEMPT_B = "dddddddd-0698-4000-8000-00000000000e";
const EFFECT_B = "dddddddd-0698-4000-8000-00000000000f";
const MANAGER_B = "dddddddd-0698-4000-8000-000000000010";
const JOB_A = "dddddddd-0698-4000-8000-000000000011";
const JOB_B = "dddddddd-0698-4000-8000-000000000012";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'execucoes-0698-b', 'Execuções B', 'Execuções B');
    insert into auth.users (id, email) values ('${MANAGER_B}', 'automacoes-manager-b@invariant.test');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MANAGER_B}', '${ORG_B}', 'manager', now());
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT_B}', '${ORG_B}', 'Contato sintético B');
    update public.crm_leads set contact_id = '${GOV_CONTACT_1}' where id = '${GOV_LEAD}';
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${VERSION_A}', '${GOV_ORG}', '{}'::jsonb), ('${VERSION_B}', '${ORG_B}', '{}'::jsonb);
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id) values
      ('${FLOW_A}', '${GOV_ORG}', 'Inspeção A', 'active', '${VERSION_A}'),
      ('${FLOW_B}', '${ORG_B}', 'Inspeção B', 'active', '${VERSION_B}');
    insert into public.followup_enrollments (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, lead_id) values
      ('${RUN_A}', '${GOV_ORG}', '${FLOW_A}', '${VERSION_A}', '${GOV_CONTACT_1}', 'task', 'paused_manual', '${GOV_LEAD}'),
      ('${RUN_B}', '${ORG_B}', '${FLOW_B}', '${VERSION_B}', '${CONTACT_B}', 'task', 'paused_manual', null),
      ('${RUN_A2}', '${GOV_ORG}', '${FLOW_A}', '${VERSION_A}', '${GOV_CONTACT_2}', 'task', 'paused_manual', null);
    insert into public.followup_execution_steps (id, organization_id, enrollment_id, node_id, visit) values
      ('${STEP_A}', '${GOV_ORG}', '${RUN_A}', 'task', 0),
      ('${STEP_B}', '${ORG_B}', '${RUN_B}', 'task', 0);
    insert into public.followup_execution_attempts (id, organization_id, step_id, attempt_no, status, completed_at, input_snapshot, output_snapshot, output_recorded)
      values ('${ATTEMPT_A}', '${GOV_ORG}', '${STEP_A}', 1, 'succeeded', now(), '{}'::jsonb, 'null'::jsonb, true);
    insert into public.followup_execution_effects (id, organization_id, enrollment_id, step_id, effect_key, operation, status, result_snapshot)
      values ('${EFFECT_A}', '${GOV_ORG}', '${RUN_A}', '${STEP_A}', 'effect-0698', 'create_task', 'confirmed', '{}'::jsonb);
    insert into public.followup_execution_attempts (id, organization_id, step_id, attempt_no, status, input_snapshot)
      values ('${ATTEMPT_B}', '${ORG_B}', '${STEP_B}', 1, 'running', '{}'::jsonb);
    insert into public.followup_execution_effects (id, organization_id, enrollment_id, step_id, effect_key, operation)
      values ('${EFFECT_B}', '${ORG_B}', '${RUN_B}', '${STEP_B}', 'effect-0698-b', 'create_task');
    insert into public.job_queue (id, organization_id, contact_id, kind, payload) values
      ('${JOB_A}', '${GOV_ORG}', '${GOV_CONTACT_1}', 'followup_turn', '{}'::jsonb),
      ('${JOB_B}', '${ORG_B}', '${CONTACT_B}', 'followup_turn', '{}'::jsonb);
    insert into public.followup_execution_attempt_jobs (organization_id, attempt_id, job_id) values
      ('${GOV_ORG}', '${ATTEMPT_A}', '${JOB_A}'),
      ('${ORG_B}', '${ATTEMPT_B}', '${JOB_B}');
  `);
});

describe("execuções inspecionáveis — banco real", () => {
  it.each([
    ["followup_execution_steps", STEP_A, STEP_B],
    ["followup_execution_attempts", ATTEMPT_A, ATTEMPT_B],
    ["followup_execution_effects", EFFECT_A, EFFECT_B],
  ] as const)("%s isola os dois tenants por JWT, com controles positivos", (table, own, other) => {
    expect(countAs(GOV_MANAGER, `select count(*) from public.${table} where id = '${own}'`)).toBe(
      1,
    );
    expect(countAs(GOV_MANAGER, `select count(*) from public.${table} where id = '${other}'`)).toBe(
      0,
    );
    expect(countAs(MANAGER_B, `select count(*) from public.${table} where id = '${other}'`)).toBe(
      1,
    );
    expect(countAs(MANAGER_B, `select count(*) from public.${table} where id = '${own}'`)).toBe(0);
    expect(countAs(GOV_MANAGER, `select count(*) from public.${table}`)).toBe(1);
    expect(countAs(MANAGER_B, `select count(*) from public.${table}`)).toBe(1);
  });

  it("followup_execution_attempt_jobs isola os dois tenants por JWT, só manager+ lê, ninguém escreve pela sessão", () => {
    const t = "public.followup_execution_attempt_jobs";
    expect(countAs(GOV_MANAGER, `select count(*) from ${t} where job_id = '${JOB_A}'`)).toBe(1);
    expect(countAs(GOV_MANAGER, `select count(*) from ${t} where job_id = '${JOB_B}'`)).toBe(0);
    expect(countAs(MANAGER_B, `select count(*) from ${t} where job_id = '${JOB_B}'`)).toBe(1);
    expect(countAs(MANAGER_B, `select count(*) from ${t} where job_id = '${JOB_A}'`)).toBe(0);
    expect(countAs(GOV_MANAGER, `select count(*) from ${t}`)).toBe(1);
    expect(countAs(MANAGER_B, `select count(*) from ${t}`)).toBe(1);
    for (const user of [GOV_VIEWER, GOV_AGENT_A]) {
      expect(countAs(user, `select count(*) from ${t}`)).toBe(0);
    }
    expect(() =>
      writeCountAs(
        GOV_MANAGER,
        `insert into ${t} (organization_id, attempt_id, job_id) values ('${GOV_ORG}', '${ATTEMPT_A}', '${JOB_A}')`,
      ),
    ).toThrow(/permission denied/i);
    expect(() => writeCountAs(GOV_MANAGER, `delete from ${t} where job_id = '${JOB_A}'`)).toThrow(
      /permission denied/i,
    );
  });

  it("a FK do vínculo recusa job ou tentativa de outra organização, mesmo com service role", () => {
    expect(() =>
      sql(
        `set role service_role; insert into public.followup_execution_attempt_jobs (organization_id, attempt_id, job_id) values ('${GOV_ORG}', '${ATTEMPT_A}', '${JOB_B}')`,
      ),
    ).toThrow(/foreign key|violates/i);
    expect(() =>
      sql(
        `set role service_role; insert into public.followup_execution_attempt_jobs (organization_id, attempt_id, job_id) values ('${GOV_ORG}', '${ATTEMPT_B}', '${JOB_A}')`,
      ),
    ).toThrow(/foreign key|violates/i);
  });

  it("não ativa o contrato novo em inscrições antigas", () => {
    expect(
      lastLine(
        sql(`select execution_contract from public.followup_enrollments where id = '${RUN_A}'`),
      ),
    ).toBe("0");
  });

  it("permite resumo ao membro e protege snapshots técnicos com manager+", () => {
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.followup_execution_steps where id = '${STEP_A}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.followup_execution_steps where id = '${STEP_B}';`,
      ),
    ).toBe(0);
    for (const user of [GOV_VIEWER, GOV_AGENT_A]) {
      expect(countAs(user, "select count(*) from public.followup_execution_attempts;")).toBe(0);
      expect(countAs(user, "select count(*) from public.followup_execution_effects;")).toBe(0);
    }
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.followup_execution_attempts where id = '${ATTEMPT_A}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.followup_execution_steps where id = '${STEP_B}';`,
      ),
    ).toBe(0);
  });

  it("não permite que a sessão falsifique ou apague os resultados", () => {
    expect(() =>
      writeCountAs(
        GOV_MANAGER,
        `update public.followup_execution_steps set status = 'running' where id = '${STEP_A}'`,
      ),
    ).toThrow(/permission denied/i);
    expect(() =>
      writeCountAs(
        GOV_MANAGER,
        `delete from public.followup_execution_attempts where id = '${ATTEMPT_A}'`,
      ),
    ).toThrow(/permission denied/i);
    expect(() =>
      writeCountAs(
        GOV_MANAGER,
        `delete from public.followup_execution_effects where id = '${EFFECT_A}'`,
      ),
    ).toThrow(/permission denied/i);
    for (const table of [
      "followup_execution_steps",
      "followup_execution_attempts",
      "followup_execution_effects",
    ]) {
      expect(
        lastLine(sql(`select has_table_privilege('anon', 'public.${table}', 'select')::text`)),
      ).toBe("false");
      expect(
        lastLine(
          sql(`select has_table_privilege('authenticated', 'public.${table}', 'truncate')::text`),
        ),
      ).toBe("false");
    }
  });

  it("a FK rejeita misturar tenants mesmo usando service role", () => {
    expect(() =>
      sql(
        `set role service_role; insert into public.followup_execution_steps (organization_id, enrollment_id, node_id, visit) values ('${ORG_B}', '${RUN_A}', 'cross', 1)`,
      ),
    ).toThrow(/foreign key/i);
    expect(() =>
      sql(
        `set role service_role; insert into public.followup_execution_attempts (organization_id, step_id, attempt_no, status) values ('${ORG_B}', '${STEP_A}', 2, 'running')`,
      ),
    ).toThrow(/foreign key/i);
  });

  it("um efeito não pode apontar para passagem de outra execução", () => {
    expect(() =>
      sql(
        `insert into public.followup_execution_effects (organization_id, enrollment_id, step_id, effect_key, operation) values ('${GOV_ORG}', '${RUN_A2}', '${STEP_A}', 'cross-effect', 'create_task')`,
      ),
    ).toThrow(/foreign key/i);
  });

  it("recuperação preserva o contato original mesmo dentro da mesma organização", () => {
    expect(() =>
      sql(
        `update public.followup_enrollments set source_enrollment_id = '${RUN_A}', recovery_kind = 'retry' where id = '${RUN_A2}'`,
      ),
    ).toThrow(/foreign key/i);
    expect(() =>
      sql(
        `update public.followup_enrollments set source_enrollment_id = '${RUN_B}', recovery_kind = 'retry' where id = '${RUN_A2}'`,
      ),
    ).toThrow(/foreign key/i);
  });

  it("lead pertence à organização e ao contato explícitos da execução", () => {
    expect(() =>
      sql(
        `update public.followup_enrollments set contact_id = '${GOV_CONTACT_2}', status = 'completed', completed_at = now() where id = '${RUN_A}'`,
      ),
    ).toThrow(/foreign key/i);
  });

  it("não admite sucesso sem resultado nem colisão de recibos", () => {
    expect(() =>
      sql(
        `insert into public.followup_execution_attempts (organization_id, step_id, attempt_no, status, completed_at) values ('${GOV_ORG}', '${STEP_A}', 2, 'succeeded', now())`,
      ),
    ).toThrow(/check constraint/i);
    expect(() =>
      sql(
        `insert into public.followup_execution_effects (organization_id, enrollment_id, step_id, effect_key, operation) values ('${GOV_ORG}', '${RUN_A}', '${STEP_A}', 'effect-0698', 'create_task')`,
      ),
    ).toThrow(/unique constraint/i);
    expect(
      lastLine(
        sql(
          `select output_recorded and output_snapshot = 'null'::jsonb from public.followup_execution_attempts where id = '${ATTEMPT_A}'`,
        ),
      ),
    ).toBe("t");
  });
});
