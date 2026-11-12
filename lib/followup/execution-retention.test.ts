import { describe, expect, it } from "vitest";

import {
  executionPayloadExpiresAt,
  executionRetentionSchema,
  readExecutionRetention,
} from "./execution-retention";

describe("retenção das execuções", () => {
  it("mantém o padrão e permite configuração parcial sem perder o outro prazo", () => {
    expect(readExecutionRetention(undefined)).toEqual({
      policy: { payload_days: 30, metadata_days: 180 },
      configuration_valid: true,
    });
    expect(readExecutionRetention({ payload_days: 15 }).policy).toEqual({
      payload_days: 15,
      metadata_days: 180,
    });
    expect(readExecutionRetention({ metadata_days: 365 }).policy).toEqual({
      payload_days: 30,
      metadata_days: 365,
    });
  });

  it.each([
    null,
    { payload_days: "10" },
    { payload_days: 0 },
    { payload_days: 366 },
    { metadata_days: 1826 },
    { payload_days: 90, metadata_days: 30 },
    { unknown: true },
  ])("sinaliza configuração inválida sem aplicar prazos parciais: %j", (raw) => {
    expect(readExecutionRetention(raw)).toEqual({
      policy: { payload_days: 30, metadata_days: 180 },
      configuration_valid: false,
    });
  });

  it("a escrita não aceita metadados mais curtos que o payload", () => {
    expect(
      executionRetentionSchema.safeParse({ payload_days: 60, metadata_days: 30 }).success,
    ).toBe(false);
    expect(
      executionRetentionSchema.safeParse({ payload_days: 60, metadata_days: 60 }).success,
    ).toBe(true);
  });

  it("conta a expiração do término em UTC e não envelhece uma execução viva", () => {
    const policy = { payload_days: 30, metadata_days: 180 };
    expect(executionPayloadExpiresAt(null, policy)).toBeNull();
    expect(executionPayloadExpiresAt("2026-10-18T23:30:00.000Z", policy)).toBe(
      "2026-11-17T23:30:00.000Z",
    );
    expect(executionPayloadExpiresAt("2026-10-18T23:30:00+00:00", policy)).toBe(
      "2026-11-17T23:30:00.000Z",
    );
    expect(executionPayloadExpiresAt("2026-10-18T20:30:00-03:00", policy)).toBe(
      "2026-11-17T23:30:00.000Z",
    );
    expect(() => executionPayloadExpiresAt("data inválida", policy)).toThrow();
  });
});
