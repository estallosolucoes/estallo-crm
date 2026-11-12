import { describe, expect, it } from "vitest";

import { EXECUTION_CONTRACT_AVAILABLE } from "./execution-contract";
import { NODE_CATALOG } from "./node-catalog";
import { declaredNodeOutputSchema, NODE_OUTPUT_CONTRACTS } from "./node-output-contracts";

const ID = "a0000000-0000-4000-8000-000000000001";
const NOW = "2026-10-18T18:00:00.000Z";

describe("saídas declaradas dos nós — contrato 1", () => {
  it("executor habilitado, sem inventar outputs de atendimento", () => {
    expect(EXECUTION_CONTRACT_AVAILABLE).toBe(true);
    expect(declaredNodeOutputSchema("collect")).toBeNull();
    expect(NODE_CATALOG.skill.output_contract_version).toBeNull();
    expect(NODE_CATALOG.internal_task.output_schema).toBe(NODE_OUTPUT_CONTRACTS.internal_task);
  });

  it("exige a tarefa real, com contato e lead explícitos", () => {
    const schema = NODE_CATALOG.internal_task.output_schema;
    expect(schema.safeParse({ success: true }).success).toBe(false);
    expect(schema.safeParse({ task_id: ID, contact_id: ID, lead_id: null }).success).toBe(true);
    expect(schema.safeParse({ task_id: ID, contact_id: ID }).success).toBe(false);
    expect(schema.safeParse({ task_id: "", contact_id: ID, lead_id: null }).success).toBe(false);
  });

  it("envio aceito exige pelo menos um recibo e não permite inventar entrega ou leitura", () => {
    const schema = NODE_OUTPUT_CONTRACTS.action;
    expect(schema.safeParse({ messages: [] }).success).toBe(false);
    expect(schema.safeParse({ messages: [{ message_id: ID, accepted_at: NOW }] }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ messages: [{ message_id: ID, accepted_at: NOW, delivered: true }] })
        .success,
    ).toBe(false);
  });

  it("não transforma ausência de resposta em classe inferida", () => {
    const schema = NODE_OUTPUT_CONTRACTS.ai_classify;
    expect(
      schema.safeParse({ classification: null, branch_id: "no_reply", reason: "no_reply" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ classification: "interessado", branch_id: "no_reply", reason: "no_reply" })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ classification: null, branch_id: "c1", reason: "classified" }).success,
    ).toBe(false);
  });

  it("não aceita volta impossível e mantém branch independente do rótulo", () => {
    const schema = NODE_OUTPUT_CONTRACTS.repeat;
    expect(
      schema.safeParse({ index: 2, total: 1, branch_id: "body", reason: "body" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ index: 0, total: 1, branch_id: "body", reason: "body" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ index: 0, total: 1, branch_id: "done", reason: "done" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ index: 1, total: 1, branch_id: "done", reason: "done" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ index: 0, total: 0, branch_id: "done", reason: "done" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ index: null, total: null, branch_id: "else", reason: "unreadable" })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ index: 0, total: 0, branch_id: "else", reason: "unreadable" }).success,
    ).toBe(false);
  });

  it("descreve objetos e listas para o seletor sem executar ações ou conter amostras", () => {
    const schema = declaredNodeOutputSchema("action");
    expect(schema).toMatchObject({
      type: "object",
      properties: { messages: { type: "array", items: { type: "object" } } },
      additionalProperties: false,
    });
    expect(JSON.stringify(schema)).not.toContain(ID);
    expect(declaredNodeOutputSchema("internal_task")).toMatchObject({
      required: ["task_id", "contact_id", "lead_id"],
    });
  });
});
