import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_ORG,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const ORG_B = randomUUID();
const USER_B = randomUUID();
const CONTACT_B = randomUUID();
const SESSION_B = randomUUID();
const CONV_B = randomUUID();

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${USER_B}', 'pins-b@invariant.test');
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'pins-rls-b', 'Pins B', 'Pins B');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'manager', now());
    insert into public.contacts (id, organization_id, display_name) values ('${CONTACT_B}', '${ORG_B}', 'Contato B');
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSION_B}', '${ORG_B}', 'pins-rls-b', '\\x00'::bytea);
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV_B}', '${ORG_B}', '${CONTACT_B}', '${SESSION_B}', 'open');
    insert into public.conversation_pins (organization_id, user_id, conversation_id) values
      ('${GOV_ORG}', '${GOV_AGENT_A}', '${GOV_CONV_UNASSIGNED}'),
      ('${GOV_ORG}', '${GOV_AGENT_B}', '${GOV_CONV_UNASSIGNED}'),
      ('${ORG_B}', '${USER_B}', '${CONV_B}');
  `);
});

describe("conversas fixadas — organização e preferência pessoal", () => {
  it("lê só os próprios pins, com controles positivos nas duas organizações", () => {
    expect(countAs(GOV_AGENT_A, "select count(*) from public.conversation_pins")).toBe(1);
    expect(countAs(USER_B, "select count(*) from public.conversation_pins")).toBe(1);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.conversation_pins where organization_id = '${ORG_B}'`,
      ),
    ).toBe(0);
    expect(
      countAs(
        USER_B,
        `select count(*) from public.conversation_pins where organization_id = '${GOV_ORG}'`,
      ),
    ).toBe(0);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.conversation_pins where user_id = '${GOV_AGENT_B}'`,
      ),
    ).toBe(0);
  });

  it("não grava pin em conversa de outra empresa nem usa o usuário do colega", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.conversation_pins (organization_id,user_id,conversation_id) values ('${GOV_ORG}','${GOV_AGENT_A}','${CONV_B}')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.conversation_pins (organization_id,user_id,conversation_id) values ('${ORG_B}','${GOV_AGENT_A}','${CONV_B}')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        USER_B,
        `insert into public.conversation_pins (organization_id,user_id,conversation_id) values ('${ORG_B}','${GOV_AGENT_A}','${CONV_B}')`,
      ),
    ).toBe(0);
  });

  it("não apaga pins de outro usuário ou organização", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `delete from public.conversation_pins where user_id = '${GOV_AGENT_B}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `delete from public.conversation_pins where organization_id = '${ORG_B}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `delete from public.conversation_pins where user_id = '${GOV_AGENT_A}'`,
      ),
    ).toBe(1);
    expect(countAs(GOV_AGENT_B, "select count(*) from public.conversation_pins")).toBe(1);
    expect(countAs(USER_B, "select count(*) from public.conversation_pins")).toBe(1);
  });
});
