/**
 * Task 8.6 — a fila mostra o agente PINADO no enrollment. Prova a função pura
 * de mapeamento `enrollmentToQueueRow` (o join `ai_agents:agent_id(name)` da
 * rota vira `agent_name`), cobrindo o embed do PostgREST nos dois formatos
 * (objeto único e array de 1) + ausência de agente pinado → null.
 */
import { describe, it, expect, vi } from "vitest";

// A rota importa server-only helpers no topo; mocka-se pra o import não puxar
// next/headers em ambiente jsdom. O último bloco exercita o GET com os dois mocks.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { GET, enrollmentToQueueRow } from "@/app/api/v1/ai/followups/queue/route";

const base = {
  id: "e1",
  contact_id: "c1",
  current_node_id: "n1",
  next_eval_at: "2026-07-23T00:00:00Z",
  status: "active",
  outcome: null,
  contacts: { id: "c1", name: "Ana", display_name: null, phone_number: null },
  followup_flow_pointers: { name: "Reativação" },
};

describe("enrollmentToQueueRow — agent_name", () => {
  it("agente pinado (embed objeto) → agent_name", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: { name: "Vendedor IA" } });
    expect(row.agent_name).toBe("Vendedor IA");
    expect(row.flow_name).toBe("Reativação");
    expect(row.contact.name).toBe("Ana");
  });

  it("agente pinado (embed array de 1, como o PostgREST às vezes devolve) → agent_name", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: [{ name: "Vendedor IA" }] });
    expect(row.agent_name).toBe("Vendedor IA");
  });

  it("sem agente pinado (agent_id null) → agent_name null", () => {
    const row = enrollmentToQueueRow({ ...base, ai_agents: null });
    expect(row.agent_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A ROTA, não só a função: o aviso de reativação (`org_reativada`) manda
// conferir em IA › Follow-ups. Se a rota deixar de selecionar `last_error` ou
// voltar a derivar o status só de enabled/cancelled_at, o disparo único que a
// suspensão desligou reaparece como "concluída" — o contrário do aviso.
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;

/** Devolve só as colunas que o `select` pediu, como o PostgREST. */
function projetar(linhas: Linha[], select: string): Linha[] {
  const colunas = select.split(/,(?![^(]*\))/).map((c) => c.trim().split(/[:(]/)[0]!.trim());
  return linhas.map((l) => Object.fromEntries(colunas.filter((c) => c in l).map((c) => [c, l[c]])));
}

function bancoFalso(tabelas: Record<string, Linha[]>) {
  return {
    from(tabela: string) {
      let select = "*";
      const b = {
        select(s: string) { select = s; return b; },
        eq() { return b; }, order() { return b; }, limit() { return b; },
        in() { return b; }, or() { return b; }, is() { return b; }, gt() { return b; },
        then(res: (v: { data: Linha[]; error: null }) => unknown) {
          return Promise.resolve({ data: projetar(tabelas[tabela] ?? [], select), error: null }).then(res);
        },
      };
      return b;
    },
  };
}

describe("GET /api/v1/ai/followups/queue — status da promessa", () => {
  it("disparo único desligado pela suspensão (last_error=org_nao_operante) → 'não disparada', não 'concluída'", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { idioma: "pt-BR" },
      org: { orgId: "o1" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);
    const promessa = {
      id: "j1", contact_id: "c1", next_run_at: null, payload: {}, cancelled_at: null,
      contacts: { id: "c1", name: "Ana", display_name: null, phone_number: null },
    };
    vi.mocked(createClient).mockResolvedValue(
      bancoFalso({
        followup_enrollments: [],
        cron_jobs: [
          { ...promessa, id: "j1", enabled: false, last_error: "org_nao_operante" },
          { ...promessa, id: "j2", enabled: false, last_error: null },
        ],
      }) as unknown as Awaited<ReturnType<typeof createClient>>,
    );

    const res = await GET(new NextRequest("http://localhost/api/v1/ai/followups/queue"));
    const corpo = (await res.json()) as { data: Array<{ id: string; status: string }> };

    expect(res.status).toBe(200);
    expect(Object.fromEntries(corpo.data.map((r) => [r.id, r.status]))).toEqual({
      j1: "não disparada",
      j2: "concluída",
    });
  });
});

// ---------------------------------------------------------------------------
// Histórico (Fase 3): período, modo, versão e negócio filtram as EXECUÇÕES e
// calam a fonte de promessas — uma promessa não tem início, modo nem versão, e
// mostrá-la sob "modo: teste" seria mentir sobre o filtro.
// ---------------------------------------------------------------------------
import { limiteDoPeriodo } from "@/app/api/v1/ai/followups/queue/route";

describe("limiteDoPeriodo", () => {
  it("data pura vale o dia inteiro: início 00:00, fim 23:59:59.999 (UTC)", () => {
    expect(limiteDoPeriodo("2026-11-05", false)).toBe("2026-11-05T00:00:00.000Z");
    expect(limiteDoPeriodo("2026-11-05", true)).toBe("2026-11-05T23:59:59.999Z");
  });
  it("instante ISO passa como está; lixo vira null", () => {
    expect(limiteDoPeriodo("2026-11-05T10:00:00Z", false)).toBe("2026-11-05T10:00:00.000Z");
    expect(limiteDoPeriodo("amanhã", false)).toBeNull();
  });
});

describe("enrollmentToQueueRow — dados do histórico", () => {
  it("leva início, fim, tentativas, passos, versão e modo; ausentes viram null, não zero", () => {
    const completa = enrollmentToQueueRow({
      ...base,
      ai_agents: null,
      started_at: "2026-11-05T10:00:00Z",
      completed_at: "2026-11-05T10:12:00Z",
      attempts: 2,
      steps_taken: 5,
      version_id: "v1",
      execution_mode: "test",
    });
    expect(completa).toMatchObject({ started_at: "2026-11-05T10:00:00Z", completed_at: "2026-11-05T10:12:00Z", attempts: 2, steps_taken: 5, version_id: "v1", mode: "test" });
    const legada = enrollmentToQueueRow({ ...base, ai_agents: null });
    expect(legada).toMatchObject({ started_at: null, completed_at: null, attempts: null, steps_taken: null, version_id: null, mode: null });
  });
});

describe("GET /api/v1/ai/followups/queue — filtros do histórico", () => {
  function sessao() {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { idioma: "pt-BR" },
      org: { orgId: "o1" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);
  }
  const get = (qs: string) => GET(new NextRequest(`http://localhost/api/v1/ai/followups/queue?${qs}`));

  it.each([
    ["desde=ontem"],
    ["ate=32/13/2026"],
    ["modo=producao"],
    ["versao=nao-e-uuid"],
    ["lead=nao-e-uuid"],
  ])("parâmetro inválido (%s) → 400, sem consultar o banco", async (qs) => {
    sessao();
    vi.mocked(createClient).mockClear();
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("aplica período, modo, versão e negócio na consulta das execuções e não lê promessas", async () => {
    sessao();
    const chamadas: Array<[string, ...unknown[]]> = [];
    const tabelasLidas: string[] = []; // só as que foram de fato AGUARDADAS (consultadas)
    vi.mocked(createClient).mockResolvedValue({
      from: (tabela: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit", "in", "or", "is", "gt", "gte", "lte"]) {
          b[m] = (...args: unknown[]) => {
            chamadas.push([m, ...args]);
            return b;
          };
        }
        b.then = (res: (v: { data: never[]; error: null }) => unknown) => {
          tabelasLidas.push(tabela);
          return Promise.resolve({ data: [], error: null }).then(res);
        };
        return b;
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const V = "11111111-1111-4111-8111-111111111111";
    const L = "22222222-2222-4222-8222-222222222222";
    const res = await get(`desde=2026-11-01&ate=2026-11-05&modo=test&versao=${V}&lead=${L}`);

    expect(res.status).toBe(200);
    expect(tabelasLidas).toEqual(["followup_enrollments"]); // promessas caladas
    expect(chamadas).toContainEqual(["gte", "started_at", "2026-11-01T00:00:00.000Z"]);
    expect(chamadas).toContainEqual(["lte", "started_at", "2026-11-05T23:59:59.999Z"]);
    expect(chamadas).toContainEqual(["eq", "execution_mode", "test"]);
    expect(chamadas).toContainEqual(["eq", "version_id", V]);
    expect(chamadas).toContainEqual(["eq", "lead_id", L]);
    expect(chamadas).toContainEqual(["eq", "organization_id", "o1"]);
  });
});
