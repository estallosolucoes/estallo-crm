import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExecutionLeadUnavailableError,
  type ExecutionLeadTarget,
} from "@/lib/followup/execution-lead";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

import {
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_LEAD,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_STAGE,
  seedGov,
  sql,
} from "./gov-helpers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode pelo pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 2,
});
const db = createPgAdminClient(pool);
const RECENT = "dddddddd-0703-4000-8000-000000000021";
const ORG_B = "dddddddd-0703-4000-8000-000000000022";
const target: ExecutionLeadTarget = { execution_contract: 1, lead_id: GOV_LEAD };

beforeAll(() => {
  seedGov();
  sql(`
    update crm_leads set contact_id='${GOV_CONTACT_1}', title='Original', tags=array['original'],
      custom_fields='{"origem":"original"}', updated_at=now()-interval '1 day' where id='${GOV_LEAD}';
    insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, tags, custom_fields)
    values ('${RECENT}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', '${GOV_CONTACT_1}',
      'Recente', array['recente'], '{"origem":"recente"}');
    insert into organizations(id,slug,legal_name,display_name)
      values ('${ORG_B}', 'alvo-do-lead-b', 'Organização B', 'Organização B');
  `);
});
afterAll(() => pool.end());

describe("adapter real do worker mantém o Lead fixado", () => {
  it("fatos e texto usam o mesmo Lead original mesmo com outro mais recente", async () => {
    expect(await db.loadLeadFacts(GOV_ORG, GOV_CONTACT_1, target)).toMatchObject({
      tags: ["original"],
      custom_fields: { origem: "original" },
    });
    expect(await db.loadRenderContext!(GOV_ORG, GOV_CONTACT_1, target)).toMatchObject({
      contact: { id: GOV_CONTACT_1 },
      lead: { id: GOV_LEAD, title: "Original" },
    });
  });

  it("null explícito conserva o contato e não seleciona Lead", async () => {
    const absent: ExecutionLeadTarget = { execution_contract: 1, lead_id: null };
    expect(await db.loadLeadFacts(GOV_ORG, GOV_CONTACT_1, absent)).toMatchObject({
      tags: [],
      lead_stage: null,
    });
    const context = await db.loadRenderContext!(GOV_ORG, GOV_CONTACT_1, absent);
    expect(context).toMatchObject({ contact: { id: GOV_CONTACT_1 } });
    expect(context).not.toHaveProperty("lead");
  });

  it.each([
    [GOV_ORG, GOV_CONTACT_2],
    [ORG_B, GOV_CONTACT_1],
  ])("recusa referência fora do contexto %s/%s nos dois leitores", async (org, contact) => {
    await expect(db.loadLeadFacts(org, contact, target)).rejects.toBeInstanceOf(
      ExecutionLeadUnavailableError,
    );
    await expect(db.loadRenderContext!(org, contact, target)).rejects.toBeInstanceOf(
      ExecutionLeadUnavailableError,
    );
  });

  it("mantém somente no legado a escolha pelo Lead mais recente", async () => {
    expect(await db.loadLeadFacts(GOV_ORG, GOV_CONTACT_1)).toMatchObject({ tags: ["recente"] });
    expect(await db.loadRenderContext!(GOV_ORG, GOV_CONTACT_1)).toMatchObject({
      lead: { id: RECENT },
    });
  });
});
