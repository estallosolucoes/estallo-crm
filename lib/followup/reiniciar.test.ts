import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  fronteira: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/atendimento/origem", () => ({ beginServiceAtOrigin: mocks.fronteira }));

import { reiniciarExecucao } from "./reiniciar";

const ORG = "org-1";
const GRAFO = {
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
};

type Resp = { data?: unknown; error?: { message: string; code?: string } | null };
interface Cenario {
  original: Resp;
  filhas: Resp;
  pointer: Resp;
  contato: Resp;
  versao: Resp;
  insert: Resp;
  /** Passos do bloco que falhou (recuperação confere resultado desconhecido). */
  passos?: Resp;
}

const ORIGINAL = {
  id: "e1",
  pointer_id: "p1",
  version_id: "v1",
  contact_id: "c1",
  lead_id: "l1",
  agent_id: "a1",
  status: "dead",
  execution_mode: "production",
  conversation_id: null,
  current_node_id: "f",
};

function cenarioBase(): Cenario {
  return {
    original: { data: ORIGINAL },
    filhas: { data: [] },
    pointer: { data: { id: "p1", status: "active", surface: "followup" } },
    contato: { data: { id: "c1", is_blocked: false, is_anonymized: false } },
    versao: { data: { graph: GRAFO } },
    insert: { data: { id: "e2", source_enrollment_id: "e1", status: "active", version_id: "v1" } },
  };
}

function banco(c: Cenario) {
  const inserts: unknown[] = [];
  const filtros: Array<[string, string, unknown]> = [];
  const cliente = {
    from(tabela: string) {
      let modo: "select" | "insert" = "select";
      let ehListaDeFilhas = false;
      const b: Record<string, unknown> = {};
      const resultado = (): Resp => {
        if (modo === "insert") return c.insert;
        if (tabela === "followup_enrollments") return ehListaDeFilhas ? c.filhas : c.original;
        if (tabela === "followup_flow_pointers") return c.pointer;
        if (tabela === "contacts") return c.contato;
        if (tabela === "followup_execution_steps") return c.passos ?? { data: [] };
        return c.versao;
      };
      b.select = () => b;
      b.insert = (linha: unknown) => {
        modo = "insert";
        inserts.push(linha);
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        filtros.push([tabela, col, val]);
        if (col === "source_enrollment_id") ehListaDeFilhas = true;
        return b;
      };
      b.maybeSingle = () => Promise.resolve({ data: resultado().data ?? null, error: resultado().error ?? null });
      b.single = () => Promise.resolve({ data: resultado().data ?? null, error: resultado().error ?? null });
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: resultado().data ?? null, error: resultado().error ?? null }).then(res);
      return b;
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, inserts, filtros };
}

const entrada = { organizationId: ORG, enrollmentId: "e1", actorUserId: "u1", requestId: "r1" };

beforeEach(() => {
  mocks.audit.mockReset();
  mocks.fronteira.mockReset();
  mocks.fronteira.mockResolvedValue({ organization_id: ORG, contact_id: "c1", conversation_id: "conv-1" });
});

describe("reiniciarExecucao", () => {
  it("cria a execução nova desde o gatilho, na MESMA versão, ligada à original como 'restart'", async () => {
    const { cliente, inserts } = banco(cenarioBase());
    const r = await reiniciarExecucao(cliente, entrada);
    expect(r).toMatchObject({ ok: true, enrollment: { id: "e2", source_enrollment_id: "e1" } });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      organization_id: ORG,
      pointer_id: "p1",
      version_id: "v1",
      contact_id: "c1",
      lead_id: "l1",
      agent_id: "a1",
      current_node_id: "t",
      status: "active",
      source_enrollment_id: "e1",
      recovery_kind: "restart",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup_enrollment.restarted", resourceId: "e2", organizationId: ORG }),
    );
  });

  it("toda leitura é da organização (nunca do body)", async () => {
    const { cliente, filtros } = banco(cenarioBase());
    await reiniciarExecucao(cliente, entrada);
    const tabelas = new Set(filtros.map(([t]) => t));
    for (const t of tabelas) expect(filtros).toContainEqual([t, "organization_id", ORG]);
  });

  it.each(["active", "waiting_reply", "dormente", "paused_manual", "paused_handoff", "coletando"])(
    "execução ainda viva (%s) não reinicia: 409 e nada é gravado",
    async (status) => {
      const c = cenarioBase();
      c.original = { data: { ...ORIGINAL, status } };
      const { cliente, inserts } = banco(c);
      const r = await reiniciarExecucao(cliente, entrada);
      expect(r).toMatchObject({ ok: false, code: "execucao_ainda_viva", status: 409 });
      expect(inserts).toHaveLength(0);
    },
  );

  it("já existe reexecução viva: recusa (clique duplo / duas pessoas)", async () => {
    const c = cenarioBase();
    c.filhas = { data: [{ id: "e2", status: "waiting_reply" }] };
    const { cliente, inserts } = banco(c);
    expect(await reiniciarExecucao(cliente, entrada)).toMatchObject({ ok: false, code: "reexecucao_em_andamento", status: 409 });
    expect(inserts).toHaveLength(0);
  });

  it("reexecução anterior já terminada não impede outra", async () => {
    const c = cenarioBase();
    c.filhas = { data: [{ id: "e2", status: "dead" }] };
    const { cliente } = banco(c);
    expect((await reiniciarExecucao(cliente, entrada)).ok).toBe(true);
  });

  it("contato bloqueado (opt-out) ou anonimizado: não volta a falar", async () => {
    for (const [campo, code] of [
      ["is_blocked", "contato_bloqueado"],
      ["is_anonymized", "contato_anonimizado"],
    ] as const) {
      const c = cenarioBase();
      c.contato = { data: { id: "c1", is_blocked: false, is_anonymized: false, [campo]: true } };
      const { cliente, inserts } = banco(c);
      expect(await reiniciarExecucao(cliente, entrada)).toMatchObject({ ok: false, code, status: 422 });
      expect(inserts).toHaveLength(0);
    }
  });

  it("fluxo inativo, roteiro de atendimento e versão ilegível são recusados", async () => {
    let c = cenarioBase();
    c.pointer = { data: { id: "p1", status: "paused", surface: "followup" } };
    expect(await reiniciarExecucao(banco(c).cliente, entrada)).toMatchObject({ code: "flow_not_active" });
    c = cenarioBase();
    c.pointer = { data: { id: "p1", status: "active", surface: "atendimento" } };
    expect(await reiniciarExecucao(banco(c).cliente, entrada)).toMatchObject({ code: "flow_not_enrollable" });
    c = cenarioBase();
    c.versao = { data: { graph: { nodes: "lixo" } } };
    expect(await reiniciarExecucao(banco(c).cliente, entrada)).toMatchObject({ code: "versao_ilegivel" });
  });

  it("execução de outra organização / inexistente: 404", async () => {
    const c = cenarioBase();
    c.original = { data: null };
    expect(await reiniciarExecucao(banco(c).cliente, entrada)).toMatchObject({ ok: false, code: "not_found", status: 404 });
  });

  it("o índice 'um vivo por contato' (23505) vira 409 legível, sem auditar", async () => {
    const c = cenarioBase();
    c.insert = { data: null, error: { message: "duplicate", code: "23505" } };
    const r = await reiniciarExecucao(banco(c).cliente, entrada);
    expect(r).toMatchObject({ ok: false, code: "conflict", status: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("passo a passo: a execução nova nasce PAUSADA no gatilho, sem horário, com a marca", async () => {
    const { cliente, inserts } = banco(cenarioBase());
    const r = await reiniciarExecucao(cliente, { ...entrada, passoAPasso: true });
    expect(r.ok).toBe(true);
    expect(inserts[0]).toMatchObject({
      current_node_id: "t",
      status: "paused_manual",
      next_eval_at: null,
      passo_a_passo: true,
      source_enrollment_id: "e1",
      recovery_kind: "restart",
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ passo_a_passo: true }) }),
    );
  });

  it("sem pedir passo a passo, nasce ativa e sem citar a marca (o caminho de sempre)", async () => {
    const { cliente, inserts } = banco(cenarioBase());
    await reiniciarExecucao(cliente, entrada);
    expect(inserts[0]).toMatchObject({ status: "active" });
    expect(inserts[0]).not.toHaveProperty("next_eval_at");
    expect(inserts[0]).not.toHaveProperty("passo_a_passo"); // a coluna nem é citada: o padrão do banco vale
  });
});

describe("reiniciarExecucao modo retry — recuperar a partir da falha (Fase 6)", () => {
  it("começa NO BLOCO QUE FALHOU, na mesma versão, ligada como retry, e audita como recuperação", async () => {
    const { cliente, inserts } = banco(cenarioBase());
    const r = await reiniciarExecucao(cliente, { ...entrada, modo: "retry" });
    expect(r.ok).toBe(true);
    expect(inserts[0]).toMatchObject({ current_node_id: "f", version_id: "v1", recovery_kind: "retry", source_enrollment_id: "e1" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "followup_enrollment.recovered" }));
  });

  it.each(["completed", "cancelled"])("execução que não falhou (%s) não se recupera: 409, nada gravado", async (status) => {
    const c = cenarioBase();
    c.original = { data: { ...ORIGINAL, status } };
    const { cliente, inserts } = banco(c);
    expect(await reiniciarExecucao(cliente, { ...entrada, modo: "retry" })).toMatchObject({ ok: false, code: "execucao_nao_falhou" });
    expect(inserts).toHaveLength(0);
  });

  it("resultado desconhecido no bloco que falhou recusa (refazer poderia repetir o efeito)", async () => {
    const c = cenarioBase();
    c.passos = { data: [{ id: "s1" }] };
    const { cliente, inserts } = banco(c);
    expect(await reiniciarExecucao(cliente, { ...entrada, modo: "retry" })).toMatchObject({ ok: false, code: "resultado_desconhecido" });
    expect(inserts).toHaveLength(0);
  });
});
