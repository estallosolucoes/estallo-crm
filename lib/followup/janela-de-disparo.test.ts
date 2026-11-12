/**
 * A faixa de horário PRÓPRIA do follow-up, no atalho inline.
 *
 * `decidirAdiamentoPorJanela` é a régua que `enviarTextoFixoPendente` consulta: só a faixa do agente
 * (`ai_agent_versions.followup.send_window`), no fuso da organização. Não há mais janela do canal.
 * A ligação no atalho (não envia, adia e registra o motivo) é medida em `enviar-texto-fixo.test.ts`.
 *
 * As âncoras são FIXAS e o fuso da organização (America/Sao_Paulo) difere do UTC: 04:00Z é 01:00 local.
 */
import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decidirAdiamentoPorJanela } from "./janela-de-disparo";

type Tabelas = Record<string, Record<string, unknown> | null | undefined>;

function admin(tabelas: Tabelas, falhas: Record<string, string> = {}) {
  const make = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => {
        const causa = falhas[table];
        if (causa) return Promise.resolve({ data: null, error: { message: causa } });
        const linha = tabelas[table] ?? {};
        return Promise.resolve({ data: Object.keys(linha).length === 0 ? null : linha, error: null });
      },
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

const FAIXA_SEG_A_SEX = { send_window: { start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] } };

function entradas(overrides: Partial<Tabelas> = {}): Tabelas {
  return {
    organizations: { timezone: "America/Sao_Paulo" },
    followup_enrollments: { agent_id: "ag-1" },
    ai_agents: { published_version_id: "v1" },
    ai_agent_versions: { followup: FAIXA_SEG_A_SEX },
    ...overrides,
  };
}

function decidir(tabelas: Tabelas, agoraISO: string, falhas: Record<string, string> = {}) {
  return decidirAdiamentoPorJanela(admin(tabelas, falhas), {
    organizationId: "org-1",
    enrollmentId: "enr-1",
    agora: new Date(agoraISO),
  });
}

describe("decidirAdiamentoPorJanela — só a faixa do agente", () => {
  it("madrugada de terça (01h local) → adia para 8h, motivo da faixa", async () => {
    const r = await decidir(entradas(), "2026-09-15T04:00:00Z");
    expect(r?.reason).toBe("followup_send_window");
    expect(r?.until.toISOString()).toBe("2026-09-15T11:00:00.000Z");
  });

  it("sexta 19h → adia direto para segunda 8h", async () => {
    const r = await decidir(entradas(), "2026-09-18T22:00:00Z");
    expect(r?.until.toISOString()).toBe("2026-09-21T11:00:00.000Z");
  });

  it("DENTRO da faixa → null (pode enviar agora)", async () => {
    expect(await decidir(entradas(), "2026-09-15T15:00:00Z")).toBeNull();
  });

  it("sem agente na inscrição (dado legado) → sem faixa, envia", async () => {
    expect(await decidir(entradas({ followup_enrollments: { agent_id: null } }), "2026-09-15T04:00:00Z")).toBeNull();
  });

  it("agente SEM versão publicada → sem faixa, envia", async () => {
    expect(await decidir(entradas({ ai_agents: { published_version_id: null } }), "2026-09-15T04:00:00Z")).toBeNull();
  });

  it("faixa com shape inválido → ignorada, sem virar mordaça", async () => {
    const r = await decidir(
      entradas({ ai_agent_versions: { followup: { send_window: { start: "xx", end: "yy" } } } }),
      "2026-09-15T04:00:00Z",
    );
    expect(r).toBeNull();
  });

  it("erro de leitura SOBE (fail-closed) — o job tenta de novo, não envia às cegas", async () => {
    await expect(decidir(entradas(), "2026-09-15T04:00:00Z", { ai_agent_versions: "boom" })).rejects.toThrow("boom");
  });
});
