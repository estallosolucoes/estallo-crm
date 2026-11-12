import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PRODUTOS NO NEGÓCIO (0660) — isolamento e a conta do valor.
 *
 * Dois eixos que nenhum outro arquivo mede:
 *  1. `crm_lead_products` não vaza entre organizações, e um item não se pendura
 *     em negócio de outra organização (o `exists` da policy de insert).
 *  2. `crm_leads.value_cents` é a soma de (quantidade × preço − desconto) dos
 *     itens, recalculada pela trigger em insert, update e delete — e nunca
 *     negativa por item.
 *
 * Como os outros invariantes: `set role authenticated` + `request.jwt.claims`,
 * o mesmo caminho do PostgREST; `postgres` ignora RLS e não mediria nada.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function comoUsuario(userId: string, script: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
  return out.split("\n").pop() ?? "";
}

function noBanco(script: string): string {
  return sql(`reset role;\n${script}`).split("\n").pop() ?? "";
}

const ORG_A = "eeee0660-0000-4000-8000-00000000000a";
const ORG_B = "eeee0660-0000-4000-8000-00000000000b";
const AGENT_A = "eeee0660-1111-4000-8000-00000000000a";
const AGENT_B = "eeee0660-1111-4000-8000-00000000000b";
const PIPE_A = "eeee0660-2222-4000-8000-00000000000a";
const PIPE_B = "eeee0660-2222-4000-8000-00000000000b";
const STAGE_A = "eeee0660-3333-4000-8000-00000000000a";
const STAGE_B = "eeee0660-3333-4000-8000-00000000000b";
const LEAD_A = "eeee0660-4444-4000-8000-00000000000a";
const LEAD_B = "eeee0660-4444-4000-8000-00000000000b";
const PROD_A = "eeee0660-5555-4000-8000-00000000000a";

const valorDoLeadA = () => noBanco(`select value_cents from public.crm_leads where id = '${LEAD_A}';`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'produtos-negocio-a@invariant.test'),
      ('${AGENT_B}', 'produtos-negocio-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'produtos-negocio-a', 'Produtos Negocio A', 'PN A'),
      ('${ORG_B}', 'produtos-negocio-b', 'Produtos Negocio B', 'PN B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${AGENT_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A}', '${ORG_A}', 'PN A', 'pn-a'),
      ('${PIPE_B}', '${ORG_B}', 'PN B', 'pn-b')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1000),
      ('${STAGE_B}', '${ORG_B}', '${PIPE_B}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_kind, assigned_at) values
      ('${LEAD_A}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', 'Negócio A', '${AGENT_A}', 'user', now()),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${STAGE_B}', 'Negócio B', '${AGENT_B}', 'user', now())
      on conflict do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents) values
      ('${PROD_A}', '${ORG_A}', 'PN-1', 'Plano anual', 100000)
      on conflict do nothing;
  `);
});

describe("crm_lead_products — o valor do negócio é a soma dos itens", () => {
  it("o agent A vincula dois itens e o valor vira a soma, com o desconto abatido", () => {
    comoUsuario(
      AGENT_A,
      `insert into public.crm_lead_products (organization_id, lead_id, product_id, nome, quantidade, preco_unitario_cents, desconto_cents)
         values ('${ORG_A}', '${LEAD_A}', '${PROD_A}', 'Plano anual', 2, 100000, 15000),
                ('${ORG_A}', '${LEAD_A}', null, 'Instalação', 1, 5000, 0);
       select 1;`,
    );
    // 2 × 1.000,00 − 150,00 + 50,00
    expect(valorDoLeadA()).toBe("190000");
  });

  it("desconto maior que o item zera o item, nunca deixa o total negativo", () => {
    comoUsuario(
      AGENT_A,
      `update public.crm_lead_products set desconto_cents = 999999
         where lead_id = '${LEAD_A}' and nome = 'Instalação';
       select 1;`,
    );
    expect(valorDoLeadA()).toBe("185000");
  });

  it("tirar o item recalcula o valor", () => {
    comoUsuario(AGENT_A, `delete from public.crm_lead_products where lead_id = '${LEAD_A}' and nome = 'Instalação'; select 1;`);
    expect(valorDoLeadA()).toBe("185000");
    comoUsuario(AGENT_A, `delete from public.crm_lead_products where lead_id = '${LEAD_A}'; select 1;`);
    expect(valorDoLeadA()).toBe("0");
  });
});

describe("crm_lead_products — isolamento entre organizações", () => {
  it("o agent B não lê os itens da org A", () => {
    comoUsuario(
      AGENT_A,
      `insert into public.crm_lead_products (organization_id, lead_id, nome, preco_unitario_cents)
         values ('${ORG_A}', '${LEAD_A}', 'Item A', 1000);
       select 1;`,
    );
    expect(comoUsuario(AGENT_A, `select count(*) from public.crm_lead_products where lead_id = '${LEAD_A}';`)).toBe("1");
    expect(comoUsuario(AGENT_B, `select count(*) from public.crm_lead_products where lead_id = '${LEAD_A}';`)).toBe("0");
  });

  it("o agent A não pendura item no negócio da org B, nem dizendo que é da org dele", () => {
    comoUsuario(
      AGENT_A,
      `do $$ begin
         insert into public.crm_lead_products (organization_id, lead_id, nome, preco_unitario_cents)
           values ('${ORG_A}', '${LEAD_B}', 'Forjado', 1);
       exception when others then null; end $$;
       do $$ begin
         insert into public.crm_lead_products (organization_id, lead_id, nome, preco_unitario_cents)
           values ('${ORG_B}', '${LEAD_B}', 'Forjado', 1);
       exception when others then null; end $$;
       select 1;`,
    );
    expect(noBanco(`select count(*) from public.crm_lead_products where nome = 'Forjado';`)).toBe("0");
    expect(noBanco(`select coalesce(value_cents, 0) from public.crm_leads where id = '${LEAD_B}';`)).toBe("0");
  });

  it("a anon key não alcança a tabela", () => {
    expect(
      noBanco(`select count(*) from information_schema.role_table_grants
                where table_schema = 'public' and table_name = 'crm_lead_products' and grantee = 'anon';`),
    ).toBe("0");
  });
});
