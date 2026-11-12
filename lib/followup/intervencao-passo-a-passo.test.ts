import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";


import { continuaAutomaticamente, executaProximoBloco, type DepsDaIntervencao } from "./intervencao";

const AGORA = new Date("2026-11-05T12:00:00.000Z");
const BASE = {
  id: "e1",
  status: "paused_manual",
  contact_id: "c1",
  pointer_id: "p1",
  version_id: "v1",
  current_node_id: "w",
  next_eval_at: null,
  claimed_until: null,
  steps_taken: 1,
  passo_a_passo: true,
};

const AGORA_BANCO = "2026-11-05T11:59:59.980Z"; // o banco 20 ms ATRÁS do processo, como medido (17–34 ms)

function montar(linha: Record<string, unknown> | null, opcoes: { atualizaLinhas?: number; rpcErro?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const eventos: Array<Record<string, unknown>> = [];
  const filtrosDoUpdate: Array<[string, unknown]> = [];
  const supabase = {
    from(tabela: string) {
      const b: Record<string, unknown> = {};
      let atualizando = false;
      b.select = () => b;
      b.update = (patch: Record<string, unknown>) => {
        atualizando = true;
        updates.push(patch);
        return b;
      };
      b.insert = (linha2: Record<string, unknown>) => {
        eventos.push(linha2);
        return Promise.resolve({ error: null });
      };
      b.eq = (c: string, v: unknown) => {
        if (atualizando) filtrosDoUpdate.push([c, v]);
        return b;
      };
      b.or = () => b;
      b.maybeSingle = () => Promise.resolve({ data: linha, error: null });
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: Array.from({ length: opcoes.atualizaLinhas ?? 1 }, () => ({ id: "e1" })),
          error: null,
        }).then(res);
      void tabela;
      return b;
    },
  } as unknown as SupabaseClient;
  const admin = {
    rpc: vi.fn(async (nome: string) =>
      nome === "fn_agora" && !opcoes.rpcErro
        ? { data: AGORA_BANCO, error: null }
        : { data: null, error: { message: "indisponível" } },
    ),
  } as unknown as SupabaseClient;
  const deps: DepsDaIntervencao = {
    supabase,
    admin,
    orgId: "org-1",
    userId: "u1",
    requestId: "r1",
    agora: AGORA,
  };
  return { deps, updates, eventos, filtrosDoUpdate };
}

describe("executaProximoBloco", () => {
  it("devolve a execução ao relógio AGORA e registra o bloco que vai rodar", async () => {
    const { deps, updates, eventos, filtrosDoUpdate } = montar(BASE);
    const r = await executaProximoBloco(deps, "e1");
    // «agora» é o do BANCO, e não o do processo: o do processo já seria futuro para o claim.
    expect(r).toMatchObject({ ok: true, status_novo: "active", next_eval_at: AGORA_BANCO });
    expect(updates[0]).toMatchObject({ status: "active", next_eval_at: AGORA_BANCO, claimed_until: null });
    expect(updates[0]).not.toHaveProperty("passo_a_passo"); // a marca FICA: o motor pausa de novo depois do bloco
    expect(eventos[0]).toMatchObject({ event_type: "step_manual", payload: expect.objectContaining({ executed_node_id: "w" }) });
    // a organização e o estado lido guardam o UPDATE
    expect(filtrosDoUpdate).toContainEqual(["organization_id", "org-1"]);
    expect(filtrosDoUpdate).toContainEqual(["status", "paused_manual"]);
  });

  it("execução que NÃO é passo a passo recusa (nada é gravado)", async () => {
    const { deps, updates } = montar({ ...BASE, passo_a_passo: false });
    expect(await executaProximoBloco(deps, "e1")).toMatchObject({ ok: false, codigo: "estado_incompativel" });
    expect(updates).toHaveLength(0);
  });

  it.each(["active", "waiting_reply", "completed", "dead", "cancelled", "paused_handoff"])(
    "só pausada por pessoa executa o próximo bloco: %s recusa",
    async (status) => {
      const { deps, updates } = montar({ ...BASE, status });
      expect(await executaProximoBloco(deps, "e1")).toMatchObject({ ok: false, codigo: "estado_incompativel" });
      expect(updates).toHaveLength(0);
    },
  );

  it("execução de outra organização / inexistente: não encontrada", async () => {
    const { deps } = montar(null);
    expect(await executaProximoBloco(deps, "e1")).toMatchObject({ ok: false, codigo: "nao_encontrado" });
  });

  it("clique duplo / motor ocupado: o UPDATE não casa nenhuma linha e vira falha, nunca sucesso mudo", async () => {
    const { deps } = montar({ ...BASE, claimed_until: "2026-11-05T12:05:00.000Z" }, { atualizaLinhas: 0 });
    expect(await executaProximoBloco(deps, "e1")).toMatchObject({ ok: false, codigo: "motor_ocupado" });
  });
});

describe("continuaAutomaticamente", () => {
  it("tira a marca e devolve ao relógio: dali em diante segue sozinha", async () => {
    const { deps, updates, eventos } = montar(BASE);
    const r = await continuaAutomaticamente(deps, "e1");
    expect(r).toMatchObject({ ok: true, status_novo: "active" });
    expect(updates[0]).toMatchObject({ passo_a_passo: false, status: "active", next_eval_at: AGORA_BANCO });
    expect(eventos[0]).toMatchObject({ event_type: "step_auto_continued" });
  });

  it("não vale para quem não é passo a passo nem para quem está andando", async () => {
    expect(await continuaAutomaticamente(montar({ ...BASE, passo_a_passo: false }).deps, "e1")).toMatchObject({ ok: false });
    expect(await continuaAutomaticamente(montar({ ...BASE, status: "active" }).deps, "e1")).toMatchObject({ ok: false });
  });

  it("se o relógio do banco não responder, cai no do processo em vez de falhar", async () => {
    const { deps, updates } = montar(BASE, { rpcErro: true });
    expect(await executaProximoBloco(deps, "e1")).toMatchObject({ ok: true, next_eval_at: AGORA.toISOString() });
    expect(updates[0]).toMatchObject({ next_eval_at: AGORA.toISOString() });
  });
});
