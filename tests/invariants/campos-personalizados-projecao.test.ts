import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O CADASTRO CENTRAL MANDA, E `settings.fields` É SÓ A PROJEÇÃO DELE (0657).
 *
 * Os consumidores antigos (validação de obrigatórios, captação, regras, IA) leem
 * `crm_pipelines.settings.fields`. Este invariante prova, no banco, que mexer na
 * definição reflete no funil: criar, restringir a etapas, tornar obrigatório,
 * ocultar e apagar. E que as etapas novas nascem coloridas (0655).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(q: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-v", "ON_ERROR_STOP=1", "-c", q],
    { encoding: "utf8" },
  ).trim();
}

const ORG = randomUUID();
let pipeline = "";
let etapas: string[] = [];

const campos = () =>
  JSON.parse(sql(`select coalesce(settings->'fields','[]'::jsonb) from public.crm_pipelines where id = '${pipeline}'`)) as Array<
    Record<string, unknown>
  >;

beforeAll(() => {
  sql(`insert into public.organizations (id, slug, legal_name, display_name)
       values ('${ORG}', 'inv-campos-${ORG.slice(0, 8)}', 'Inv Campos', 'Inv Campos')`);
  pipeline = sql(`select id from public.crm_pipelines where organization_id = '${ORG}' order by position limit 1`);
  if (!pipeline) {
    pipeline = randomUUID();
    sql(`insert into public.crm_pipelines (id, organization_id, name, slug) values ('${pipeline}', '${ORG}', 'Funil', 'funil')`);
  }
  for (const [i, nome] of ["Novo", "Contato", "Proposta"].entries()) {
    sql(`insert into public.crm_stages (organization_id, pipeline_id, name, slug, position)
         values ('${ORG}', '${pipeline}', 'Inv ${nome}', 'inv-${nome.toLowerCase()}', ${90000 + i * 1000})
         on conflict do nothing`);
  }
  etapas = sql(`select id from public.crm_stages where pipeline_id = '${pipeline}' and slug like 'inv-%' order by position`).split("\n");
});

describe("projeção dos campos centrais em settings.fields", () => {
  it("etapa nova nasce com cor, diferente da vizinha anterior", () => {
    const cores = sql(`select color from public.crm_stages where pipeline_id = '${pipeline}' and slug like 'inv-%' order by position`).split("\n");
    expect(cores.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
    for (let i = 1; i < cores.length; i++) expect(cores[i]).not.toBe(cores[i - 1]);
  });

  it("criar a definição de lead projeta o campo no funil", () => {
    sql(`insert into public.custom_field_definitions (organization_id, entity, key, label, type)
         values ('${ORG}', 'lead', 'interesse', 'Interesse', 'text')`);
    expect(campos().map((c) => c.key)).toContain("interesse");
  });

  it("visível só numa etapa: a projeção leva a lista dessa etapa", () => {
    sql(`update public.custom_field_definitions
            set visivel_global = false, etapas_visiveis = array['${etapas[1]}']::uuid[]
          where organization_id = '${ORG}' and key = 'interesse'`);
    const campo = campos().find((c) => c.key === "interesse");
    expect(campo?.etapas_visiveis).toEqual([etapas[1]]);
  });

  it("obrigatório na empresa: exige ao sair da primeira etapa aberta e ao ganhar", () => {
    sql(`update public.custom_field_definitions set visivel_global = true, obrigatorio = 'empresa'
          where organization_id = '${ORG}' and key = 'interesse'`);
    const campo = campos().find((c) => c.key === "interesse") as {
      required?: boolean;
      obrigatorio_em?: { etapas: string[]; ao_ganhar: boolean };
    };
    expect(campo.required).toBe(true);
    expect(campo.obrigatorio_em?.ao_ganhar).toBe(true);
    expect(campo.obrigatorio_em?.etapas).toEqual(expect.arrayContaining([etapas[1], etapas[2]]));
  });

  it("definição de CONTATO não entra na projeção do funil", () => {
    sql(`insert into public.custom_field_definitions (organization_id, entity, key, label, type)
         values ('${ORG}', 'contact', 'cpf', 'CPF', 'text')`);
    expect(campos().map((c) => c.key)).not.toContain("cpf");
  });

  it("ocultar tira do funil, e apagar a última limpa a projeção", () => {
    sql(`update public.custom_field_definitions set hidden = true where organization_id = '${ORG}' and key = 'interesse'`);
    expect(campos().map((c) => c.key)).not.toContain("interesse");
    sql(`delete from public.custom_field_definitions where organization_id = '${ORG}' and entity = 'lead'`);
    expect(campos()).toEqual([]);
  });
});
