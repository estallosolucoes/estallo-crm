import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const VERSION = randomUUID();
const FLOW = randomUUID();

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.followup_flow_versions (id, organization_id, graph) values ('${VERSION}', '${GOV_ORG}', '{}'::jsonb);
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id)
      values ('${FLOW}', '${GOV_ORG}', 'Retenção de automações', 'active', '${VERSION}');
  `);
});

beforeEach(() => {
  sql(
    `update public.organizations set settings = coalesce(settings, '{}'::jsonb) - 'automations' where id = '${GOV_ORG}'`,
  );
});

function seedExecution(
  options: { age_days?: number; live?: boolean; source?: string; contract?: number } = {},
) {
  const contact = options.source
    ? lastLine(
        sql(
          `select contact_id from public.followup_enrollments where id = '${options.source}' and organization_id = '${GOV_ORG}'`,
        ),
      )
    : randomUUID();
  const run = randomUUID();
  const step = randomUUID();
  const attempt = randomUUID();
  const effect = randomUUID();
  const days = options.age_days ?? 45;
  const status = options.live ? "paused_manual" : "completed";
  const completed = options.live ? "null" : `now() - interval '${days} days'`;
  sql(`
    insert into public.contacts (id, organization_id, display_name) values ('${contact}', '${GOV_ORG}', 'Contato sintético') on conflict (id) do nothing;
    insert into public.followup_enrollments (id, organization_id, pointer_id, version_id, contact_id, current_node_id, status, execution_contract, started_at, completed_at, source_enrollment_id, recovery_kind)
      values ('${run}', '${GOV_ORG}', '${FLOW}', '${VERSION}', '${contact}', 'task', '${status}', ${options.contract ?? 1},
        now() - interval '${days + 1} days', ${completed}, ${options.source ? `'${options.source}'` : "null"}, ${options.source ? "'retry'" : "null"});
    insert into public.followup_execution_steps (id, organization_id, enrollment_id, node_id, visit, status, entered_at, completed_at)
      values ('${step}', '${GOV_ORG}', '${run}', 'task', 0, 'succeeded', now() - interval '${days + 1} days', now() - interval '${days} days');
    insert into public.followup_execution_attempts (id, organization_id, step_id, attempt_no, status, started_at, completed_at, input_snapshot, config_snapshot, output_snapshot, output_recorded)
      values ('${attempt}', '${GOV_ORG}', '${step}', 1, 'succeeded', now() - interval '${days + 1} days', now() - interval '${days} days',
        '{"contact":"sintético"}'::jsonb, '{"title":"tarefa sintética"}'::jsonb, '{"result":"sintético"}'::jsonb, true);
    insert into public.followup_execution_effects (id, organization_id, enrollment_id, step_id, effect_key, operation, status, result_snapshot, external_ref)
      values ('${effect}', '${GOV_ORG}', '${run}', '${step}', '${effect}', 'create_task', 'confirmed', '{"result":"sintético"}'::jsonb, 'referência sintética');
  `);
  return { contact, run, step, attempt, effect };
}

function hasPayload(attempt: string): boolean {
  return (
    lastLine(
      sql(
        `select input_snapshot is not null from public.followup_execution_attempts where id = '${attempt}'`,
      ),
    ) === "t"
  );
}

function runExists(id: string): boolean {
  return (
    lastLine(sql(`select exists(select 1 from public.followup_enrollments where id = '${id}')`)) ===
    "t"
  );
}

describe("retenção e anonimização de automações no banco", () => {
  it("expira payload e referências sem converter ausência em um output real", () => {
    const fixture = seedExecution();
    expect(hasPayload(fixture.attempt)).toBe(true);
    sql("select public.fn_expurgar_payloads_de_automacao(30, 1000)");
    expect(hasPayload(fixture.attempt)).toBe(false);
    expect(
      lastLine(
        sql(
          `select payload_expired_at is not null and output_snapshot is null and config_snapshot is null and output_recorded and status = 'succeeded' from public.followup_execution_attempts where id = '${fixture.attempt}'`,
        ),
      ),
    ).toBe("t");
    expect(
      lastLine(
        sql(
          `select payload_expired_at is not null and result_snapshot is null and external_ref is null and status = 'confirmed' from public.followup_execution_effects where id = '${fixture.effect}'`,
        ),
      ),
    ).toBe("t");
    expect(runExists(fixture.run)).toBe(true);
  });

  it("preserva execução viva e os checkpoints dos quais depende", () => {
    const parent = seedExecution({ age_days: 400 });
    const child = seedExecution({ age_days: 400, live: true, source: parent.run });
    sql(
      "select public.fn_expurgar_payloads_de_automacao(30, 1000); select public.fn_expurgar_execucoes_de_automacao(180, 1000);",
    );
    expect(hasPayload(parent.attempt)).toBe(true);
    expect(hasPayload(child.attempt)).toBe(true);
    expect(runExists(parent.run)).toBe(true);
    expect(runExists(child.run)).toBe(true);
  });

  it("aplica política por organização e mantém o legado intacto", () => {
    sql(
      `update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{automations}', '{"retention":{"payload_days":15,"metadata_days":365}}'::jsonb) where id = '${GOV_ORG}'`,
    );
    const recent = seedExecution({ age_days: 20 });
    const withinMetadata = seedExecution({ age_days: 200 });
    const expired = seedExecution({ age_days: 400 });
    const legacy = seedExecution({ age_days: 400, contract: 0 });
    sql(
      "select public.fn_expurgar_payloads_de_automacao(30, 1000); select public.fn_expurgar_execucoes_de_automacao(180, 1000);",
    );
    expect(hasPayload(recent.attempt)).toBe(false);
    expect(runExists(withinMetadata.run)).toBe(true);
    expect(runExists(expired.run)).toBe(false);
    expect(runExists(legacy.run)).toBe(true);
    expect(hasPayload(legacy.attempt)).toBe(true);
  });

  it("remove a cadeia encerrada no mesmo lote, sem apagar um pai ainda referenciado", () => {
    const parent = seedExecution({ age_days: 400 });
    const child = seedExecution({ age_days: 400, source: parent.run });
    sql("select public.fn_expurgar_execucoes_de_automacao(180, 1000)");
    expect(runExists(child.run)).toBe(false);
    expect(runExists(parent.run)).toBe(false);
  });

  it("configuração inválida sinaliza fallback inteiro sem cast que estoure", () => {
    sql(
      `update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{automations}', '{"retention":{"payload_days":99999999999999999999,"metadata_days":30}}'::jsonb) where id = '${GOV_ORG}'`,
    );
    expect(
      lastLine(
        sql(
          `select payload_days || ':' || metadata_days || ':' || configuration_valid from public.fn_followup_retention_policy('${GOV_ORG}')`,
        ),
      ),
    ).toBe("30:180:false");
    sql(
      `update public.organizations set settings = jsonb_set(settings, '{automations,retention}', '{"payload_days":30.0,"metadata_days":180.0}'::jsonb) where id = '${GOV_ORG}'`,
    );
    expect(
      lastLine(
        sql(
          `select payload_days || ':' || metadata_days || ':' || configuration_valid from public.fn_followup_retention_policy('${GOV_ORG}')`,
        ),
      ),
    ).toBe("30:180:true");
  });

  it("expurgo impede repor snapshots e recibos mesmo apagando a marca em escrita tardia", () => {
    const fixture = seedExecution({ age_days: 40 });
    sql("select public.fn_expurgar_payloads_de_automacao(30, 1000)");
    const expiredAt = lastLine(
      sql(
        `select payload_expired_at from public.followup_execution_attempts where id = '${fixture.attempt}'`,
      ),
    );
    expect(hasPayload(fixture.attempt)).toBe(false);
    sql(`update public.followup_execution_attempts set payload_expired_at = null,
      input_snapshot = '{"late":"dado"}'::jsonb, config_snapshot = '{}'::jsonb,
      output_snapshot = '{"late":"dado"}'::jsonb where id = '${fixture.attempt}';
      update public.followup_execution_effects set payload_expired_at = null,
      result_snapshot = '{"late":"dado"}'::jsonb, external_ref = 'dado tardio' where id = '${fixture.effect}';`);
    expect(
      lastLine(
        sql(`select input_snapshot is null and config_snapshot is null and output_snapshot is null
      and error_snapshot is null from public.followup_execution_attempts where id = '${fixture.attempt}'`),
      ),
    ).toBe("t");
    expect(
      lastLine(
        sql(
          `select payload_expired_at from public.followup_execution_attempts where id = '${fixture.attempt}'`,
        ),
      ),
    ).toBe(expiredAt);
    expect(
      lastLine(
        sql(`select result_snapshot is null and external_ref is null and payload_expired_at is not null
      from public.followup_execution_effects where id = '${fixture.effect}'`),
      ),
    ).toBe("t");
  });

  it("anonimização alcança snapshots e recibos, inclusive escrita tardia", () => {
    const fixture = seedExecution({ age_days: 1 });
    sql(
      `update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${fixture.contact}' and organization_id = '${GOV_ORG}'`,
    );
    expect(hasPayload(fixture.attempt)).toBe(false);
    sql(`update public.followup_execution_attempts set input_snapshot = '{"late":"dado"}'::jsonb, output_snapshot = '{"late":"dado"}'::jsonb where id = '${fixture.attempt}';
      update public.followup_execution_effects set result_snapshot = '{"late":"dado"}'::jsonb, external_ref = 'dado tardio' where id = '${fixture.effect}';`);
    expect(hasPayload(fixture.attempt)).toBe(false);
    expect(
      lastLine(
        sql(
          `select result_snapshot is null and external_ref is null and payload_expired_at is not null from public.followup_execution_effects where id = '${fixture.effect}'`,
        ),
      ),
    ).toBe("t");
  });

  it("altera a política sem perder outras configurações e rejeita mudança inválida atomicamente", () => {
    sql(
      `update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"unrelated":"preservado","automations":{"other":true}}'::jsonb where id = '${GOV_ORG}'`,
    );
    expect(
      lastLine(
        sql(
          `select public.fn_set_followup_retention_policy('${GOV_ORG}', '{"payload_days":15,"metadata_days":365}'::jsonb)`,
        ),
      ),
    ).toBe("t");
    expect(
      lastLine(
        sql(
          `select settings->>'unrelated' = 'preservado' and settings #>> '{automations,other}' = 'true' from public.organizations where id = '${GOV_ORG}'`,
        ),
      ),
    ).toBe("t");
    expect(() =>
      sql(
        `select public.fn_set_followup_retention_policy('${GOV_ORG}', '{"payload_days":90,"metadata_days":30}'::jsonb)`,
      ),
    ).toThrow(/invalid_followup_retention_policy/);
    expect(
      lastLine(
        sql(
          `select payload_days || ':' || metadata_days from public.fn_followup_retention_policy('${GOV_ORG}')`,
        ),
      ),
    ).toBe("15:365");
  });

  it("a limpeza exige organização correta e é idempotente", () => {
    const fixture = seedExecution({ age_days: 1 });
    expect(
      lastLine(
        sql(
          `select public.fn_redigir_payloads_execucao('00000000-0000-4000-8000-000000000000', '${fixture.run}')`,
        ),
      ),
    ).toBe("0");
    expect(hasPayload(fixture.attempt)).toBe(true);
    sql(`select public.fn_redigir_payloads_execucao('${GOV_ORG}', '${fixture.run}')`);
    expect(
      lastLine(sql(`select public.fn_redigir_payloads_execucao('${GOV_ORG}', '${fixture.run}')`)),
    ).toBe("0");
  });

  it("não expõe funções de limpeza ou política para sessões ou anônimos", () => {
    const signatures = [
      "fn_redigir_payloads_execucao(uuid,uuid)",
      "fn_followup_protected_execution_ids()",
      "fn_followup_retention_policy(uuid,integer,integer)",
      "fn_set_followup_retention_policy(uuid,jsonb)",
      "fn_expurgar_payloads_de_automacao(integer,integer)",
      "fn_expurgar_execucoes_de_automacao(integer,integer)",
    ];
    for (const signature of signatures) {
      expect(
        lastLine(sql(`select has_function_privilege('anon', 'public.${signature}', 'execute')`)),
      ).toBe("f");
      expect(
        lastLine(
          sql(`select has_function_privilege('authenticated', 'public.${signature}', 'execute')`),
        ),
      ).toBe("f");
      expect(
        lastLine(
          sql(`select has_function_privilege('service_role', 'public.${signature}', 'execute')`),
        ),
      ).toBe("t");
    }
  });
});
