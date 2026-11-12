import { beforeAll, describe, expect, it } from "vitest";

import {
  columnExists,
  indexExists,
  seedGov,
  sql,
  GOV_ORG,
  GOV_CONV_UNASSIGNED,
} from "./gov-helpers";

/**
 * Eixo 7 — Tags (spec 13 §1; fase que fecha: G3).
 * docs/specs/13-spec-governanca-atendimento.md — dor: "origem/categoria/
 * etiquetas ausentes ou não-filtráveis". Padrão do repo: tags text[] + GIN
 * (CLAUDE.md §Modelagem); alvo conversations.tags na spec 13 §3 —
 * superado pela 0659: a etiqueta é do contato e do negócio.
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 7 — tags", () => {
  it("contacts.tags e crm_leads.tags existem com índice GIN (padrão filtrável)", () => {
    expect(columnExists("contacts", "tags")).toBe(true);
    expect(columnExists("crm_leads", "tags")).toBe(true);
    expect(indexExists("idx_contacts_tags_gin")).toBe(true);
    expect(indexExists("idx_crm_leads_tags_gin")).toBe(true);
  });

  // Estallo (migration 0659): conversa NÃO tem tag. A etiqueta é do contato e
  // do negócio; a coluna ficou só porque a anonimização LGPD ainda a zera, e o
  // CHECK garante que ninguém volte a gravar nela.
  it("conversations.tags fica vazia e travada; o índice de filtro saiu", () => {
    expect(columnExists("conversations", "tags")).toBe(true);
    expect(indexExists("idx_conversations_tags_gin")).toBe(false);
    expect(() =>
      sql(`update public.conversations set tags = array['reclamacao'] where id = '${GOV_CONV_UNASSIGNED}';`),
    ).toThrow(/conversations_sem_tags/);
  });

  // G3-05 acceptance 4, agora pela tag do CONTATO: o filtro é org-scoped.
  it("filtro por tag do contato é org-scoped — tags && array[...] não vaza entre orgs", () => {
    const ORG2 = "cccccccc-0000-4000-8000-000000000002";
    const C1 = "cccccccc-3333-4000-8000-000000000015";
    const C2 = "cccccccc-3333-4000-8000-000000000005";

    sql(`
      insert into public.contacts (id, organization_id, display_name, tags)
        values ('${C1}', '${GOV_ORG}', 'Gov Tag Org1', array['reclamacao'])
        on conflict (id) do update set tags = excluded.tags;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG2}', 'gov-inv-2', 'Gov Invariant Org 2', 'Gov Inv 2')
        on conflict do nothing;
      insert into public.contacts (id, organization_id, display_name, tags)
        values ('${C2}', '${ORG2}', 'Gov Invariant Contact Org2', array['reclamacao'])
        on conflict (id) do update set tags = excluded.tags;
    `);

    const count = (q: string) => Number(sql(q).trim());
    expect(
      count(`select count(*) from public.contacts
        where organization_id = '${GOV_ORG}' and tags && array['reclamacao'];`),
    ).toBe(1);
    expect(
      count(`select count(*) from public.contacts where tags && array['reclamacao'];`),
    ).toBeGreaterThanOrEqual(2);
    expect(
      count(`select count(*) from public.contacts
        where organization_id = '${ORG2}' and tags && array['reclamacao'];`),
    ).toBe(1);
  });
});
