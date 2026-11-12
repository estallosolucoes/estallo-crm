import { describe, expect, it, vi } from "vitest";

import { NODES_INTEGRATED_IN_EXECUTION_CONTRACT } from "@/lib/automation/execution-capability";
import type * as ContractModule from "./execution-contract";
import type { ExecutionJournal } from "./execution-journal";
import { flowGraphSchema, flowNodeSchema, type FlowGraph } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";
import { completeTurnForEnrollment, type TurnBridgeAdminClient } from "./turn-bridge";
import { validateFlowForPublish } from "./validate-publish";

vi.mock("./execution-contract", async (original) => {
  const m = await original<typeof ContractModule>();
  return {
    ...m,
    executionContractProblem: (...a: Parameters<typeof m.executionContractProblem>) => {
      const p = m.executionContractProblem(...a);
      return p === "execution_contract_unavailable" ? null : p;
    },
  };
});

const pos = { x: 0, y: 0 };
// Um nó mínimo e VÁLIDO no schema para cada um dos tipos do grafo.
const NOS: Record<string, FlowGraph["nodes"][number]> = {
  trigger: { id: "n", type: "trigger", label: "t", position: pos, config: {} },
  wait: {
    id: "n",
    type: "wait",
    label: "w",
    position: pos,
    config: { mode: "fixed", duration_ms: 300_000 },
  },
  condition: {
    id: "n",
    type: "condition",
    label: "c",
    position: pos,
    config: { combinator: "and", checks: [{ field: "tag", op: "eq", value: "x" }] },
  },
  ai_classify: {
    id: "n",
    type: "ai_classify",
    label: "a",
    position: pos,
    config: { classes: ["quente"], grace_timeout_ms: 900_000, target: "last_reply" },
  },
  match_reply: {
    id: "n",
    type: "match_reply",
    label: "m",
    position: pos,
    config: {
      branches: [{ id: "b1", label: "sim", op: "eq", pattern: "sim" }],
      grace_timeout_ms: 900_000,
    },
  },
  repeat: { id: "n", type: "repeat", label: "r", position: pos, config: { max_count: 2 } },
  collect: {
    id: "n",
    type: "collect",
    label: "k",
    position: pos,
    config: { key: "nome", label: "Nome", type: "text", required: true, permite_correcao: true },
  },
  skill: { id: "n", type: "skill", label: "s", position: pos, config: { skill_name: "x" } },
  action: {
    id: "n",
    type: "action",
    label: "ac",
    position: pos,
    config: { mode: "text", body: "oi" },
  },
  internal_task: {
    id: "n",
    type: "internal_task",
    label: "it",
    position: pos,
    config: { titulo: "x", vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "medium" },
  },
  move_lead: {
    id: "n",
    type: "move_lead",
    label: "ml",
    position: pos,
    config: { stage_id: "00000000-0000-4000-8000-000000000001" } as never,
  },
  edit_lead_tag: {
    id: "n",
    type: "edit_lead_tag",
    label: "et",
    position: pos,
    config: { tags: ["x"] },
  },
  lead_product: {
    id: "n",
    type: "lead_product",
    label: "lp",
    position: pos,
    config: { acao: "add", product_id: "00000000-0000-4000-8000-000000000003", quantidade: 1 },
  },
  find_or_create_contact: {
    id: "n",
    type: "find_or_create_contact",
    label: "fc",
    position: pos,
    config: { busca: "phone", valor: "+5511999990000", criar: true, nome: "" },
  },
  find_or_create_lead: {
    id: "n",
    type: "find_or_create_lead",
    label: "fl",
    position: pos,
    config: { contato: "", pipeline_id: "00000000-0000-4000-8000-000000000005", stage_id: "00000000-0000-4000-8000-000000000006", titulo: "Novo", criar: true },
  },
  http_request: {
    id: "n",
    type: "http_request",
    label: "http",
    position: pos,
    config: { connection_id: "00000000-0000-4000-8000-000000000004", metodo: "GET", caminho: "/", corpo: "" },
  },
  update_lead_field: {
    id: "n",
    type: "update_lead_field",
    label: "uf",
    position: pos,
    config: { alvo: "deal_value", chave: "", valor: "10" },
  },
  add_note: {
    id: "n",
    type: "add_note",
    label: "an",
    position: pos,
    config: { destino: "lead_timeline", texto: "x" },
  },
  assign_lead_owner: {
    id: "n",
    type: "assign_lead_owner",
    label: "al",
    position: pos,
    config: { usuario_id: "00000000-0000-4000-8000-000000000002" },
  },
  map_data: {
    id: "n",
    type: "map_data",
    label: "md",
    position: pos,
    config: { fields: [{ name: "x", value: "fixo", type: "text" }] },
  },
  end: { id: "n", type: "end", label: "e", position: pos, config: { outcome: "exhausted" } },
};

const TIPOS_DO_SCHEMA = flowNodeSchema.options.map((o) => o.shape.type.value as string);
// Verdade independente: o que engine.ts roteia pelo diário no contrato 1 (begin + complete*).
const INTEGRADOS_PELO_ENGINE = new Set([
  "trigger",
  "condition",
  "wait",
  "repeat",
  "end",
  "action",
  "ai_classify",
  "match_reply",
  "internal_task",
  "edit_lead_tag",
  "move_lead",
  "map_data",
  "assign_lead_owner",
  "add_note",
  "update_lead_field",
  "lead_product",
  "http_request",
  "find_or_create_contact",
  "find_or_create_lead",
]);

const grafoCom = (node: FlowGraph["nodes"][number], extra: FlowGraph["nodes"] = []): FlowGraph => ({
  execution_contract: 1,
  nodes: [
    { id: "start", type: "trigger", label: "i", position: pos, config: {} },
    node,
    ...extra,
    { id: "end", type: "end", label: "f", position: pos, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "a", source: "start", target: node.id, priority: 0, condition: { type: "always" } },
    { id: "b", source: node.id, target: "end", priority: 0, condition: { type: "always" } },
  ],
});
const codigos = (g: FlowGraph, surface?: "followup" | "atendimento" | "crm_automation") => {
  const r = validateFlowForPublish(g, surface ? { surface } : {});
  return r.ok
    ? []
    : r.errors.filter((e) => e.code === "execution_node_not_integrated").map((e) => e.node_id);
};

describe("ataque: lista de nós integrados x schema x engine", () => {
  it("o fixture cobre TODOS os tipos do schema (se um tipo novo nascer, este teste quebra)", () => {
    expect(Object.keys(NOS).sort()).toEqual([...TIPOS_DO_SCHEMA].sort());
  });

  it("a lista do contrato é subconjunto do schema e igual ao que o engine roteia pelo diário", () => {
    for (const t of NODES_INTEGRATED_IN_EXECUTION_CONTRACT) expect(TIPOS_DO_SCHEMA).toContain(t);
    expect([...NODES_INTEGRATED_IN_EXECUTION_CONTRACT].sort()).toEqual(
      [...INTEGRADOS_PELO_ENGINE].sort(),
    );
  });

  it.each(TIPOS_DO_SCHEMA)("tipo %s: validador recusa se, e somente se, fora da lista", (tipo) => {
    // fixtures parseiam no schema (sem isso o teste provaria o fixture, não o validador)
    expect(flowNodeSchema.safeParse(NOS[tipo]).success).toBe(true);
    const flagged = codigos(grafoCom(NOS[tipo]!));
    if (INTEGRADOS_PELO_ENGINE.has(tipo)) expect(flagged).toEqual([]);
    else expect(flagged).toEqual(["n"]);
  });

  it.each(["followup", "atendimento", "crm_automation"] as const)(
    "superfície %s não escapa da regra (collect/skill) e a captação passa em todos os modos",
    (surface) => {
      for (const tipo of ["collect", "skill"]) {
        expect(codigos(grafoCom(NOS[tipo]!), surface)).toEqual(["n"]);
      }
      const captacao = {
        ...NOS.match_reply!,
        config: {
          branches: [{ id: "b1", label: "sim", op: "eq", pattern: "sim" }],
          grace_timeout_ms: 900_000,
          save_to: { kind: "contact_name" },
          if_exists: "confirm",
        },
      } as FlowGraph["nodes"][number];
      expect(flowNodeSchema.safeParse(captacao).success).toBe(true);
      for (const modo of [undefined, "overwrite", "skip", "confirm"] as const) {
        const integrada = {
          ...captacao,
          config: { ...(captacao.config as object), if_exists: modo },
        } as FlowGraph["nodes"][number];
        expect(codigos(grafoCom(integrada), surface)).toEqual([]);
      }
    },
  );

  it("nó fora da lista INALCANÇÁVEL escondido entre esperas também é recusado; espera smart e captação com confirmação passam", () => {
    const solto = { ...NOS.skill!, id: "orfao" };
    expect(codigos(grafoCom(NOS.wait!, [solto]))).toEqual(["orfao"]);
    const smart = {
      id: "s",
      type: "wait",
      label: "w",
      position: pos,
      config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000 },
    } as FlowGraph["nodes"][number];
    const captacao = {
      ...NOS.match_reply!,
      id: "c",
      config: {
        branches: [{ id: "b1", label: "sim", op: "eq", pattern: "sim" }],
        grace_timeout_ms: 900_000,
        save_to: { kind: "contact_name" },
        if_exists: "confirm",
      },
    } as FlowGraph["nodes"][number];
    const fixa2 = { ...NOS.wait!, id: "f2" };
    expect(codigos(grafoCom(NOS.wait!, [fixa2, smart]))).toEqual([]);
    expect(codigos(grafoCom(NOS.wait!, [fixa2, smart, captacao]))).toEqual([]);
  });

  it("contrato com valor falso-ish (0/null) não vira rota de fuga: segue recusado e o schema recusa", () => {
    for (const v of [0, null, false, "1"]) {
      const g = { ...grafoCom(NOS.skill!), execution_contract: v } as unknown as FlowGraph;
      expect(flowGraphSchema.safeParse(g).success).toBe(false);
      // validador direto (rota de publish NÃO re-parseia o draft_graph): precisa ao menos recusar
      const r = validateFlowForPublish(g);
      expect(r.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Ponte: matriz resultado x nó no contrato 1
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-19T12:00:00Z");
const claim = { worker_id: "w", acquired_at: NOW.toISOString() };
const graphBridge = flowGraphSchema.parse({
  execution_contract: 1,
  nodes: [
    { id: "send", type: "action", label: "e", position: pos, config: { mode: "text", body: "oi" } },
    { ...NOS.match_reply, id: "mr" },
    { ...NOS.ai_classify, id: "cl" },
    { ...NOS.trigger, id: "tr" },
    { id: "end", type: "end", label: "f", position: pos, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "e1", source: "send", target: "end", condition: { type: "always" } },
    { id: "e2", source: "mr", target: "end", condition: { type: "always" } },
    { id: "e3", source: "cl", target: "end", condition: { type: "always" } },
    { id: "e4", source: "tr", target: "end", condition: { type: "always" } },
  ],
});
function enrollmentRow(node: string): EnrollmentRow {
  return {
    id: "run",
    organization_id: "org",
    pointer_id: "p",
    version_id: "v",
    contact_id: "c",
    lead_id: null,
    conversation_id: null,
    execution_contract: 1,
    revision: 3,
    current_node_id: node,
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 1,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
  } as EnrollmentRow;
}
function mkDb(node: string) {
  const completeSend = vi.fn(async () => ({ output: null, reused: false }));
  const completeSkipped = vi.fn(async () => ({ reused: false }));
  const deferSend = vi.fn(async () => ({ reused: false }));
  const db = {
    loadEnrollmentById: vi.fn(async () => enrollmentRow(node)),
    loadFlowGraph: vi.fn(async () => graphBridge),
    assertFollowupJob: vi.fn(async () => {}),
    assertServiceBoundary: vi.fn(async () => {}),
    assertAgenda: vi.fn(async () => {}),
    executionJournal: vi.fn(
      async () => ({ completeSend, completeSkipped, deferSend }) as unknown as ExecutionJournal,
    ),
    updateEnrollment: vi.fn(async () => {}),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
  } as unknown as TurnBridgeAdminClient;
  return { db, completeSend, completeSkipped, deferSend };
}
const escreveuForaDoDiario = (db: TurnBridgeAdminClient) =>
  (db.updateEnrollment as ReturnType<typeof vi.fn>).mock.calls.length +
  (db.insertEnrollmentEvent as ReturnType<typeof vi.fn>).mock.calls.length;

describe("ataque: ponte no contrato 1 nunca grava FORA do diário (falha fechada)", () => {
  const casos: [string, string, unknown][] = [
    ["send", "skipped", { kind: "skipped", reason: "opt_out" }],
    [
      "send",
      "deferred",
      { kind: "deferred", until: new Date("2026-10-20T10:00:00Z"), reason: "janela" },
    ],
    ["mr", "sent (match_reply)", { kind: "sent" }],
    ["send", "classified", { kind: "classified", class: "x" }],
    ["send", "awaiting_reply", { kind: "awaiting_reply" }],
    ["send", "planned", { kind: "planned", propostas: [], modelo: "m" }],
    ["cl", "sent (ai_classify)", { kind: "sent" }],
    ["tr", "sent (trigger)", { kind: "sent" }],
  ];
  // As duas lacunas conhecidas (skipped/deferred) foram fechadas: agora passam pelo diário.
  const LACUNAS = new Set<string>();
  for (const [node, nome, result] of casos)
    (LACUNAS.has(nome) ? it.fails : it)(
      `nó ${node} + resultado ${nome}: lança OU não escreve nada fora do diário`,
      async () => {
        const { db } = mkDb(node);
        let lancou = false;
        try {
          await completeTurnForEnrollment(
            db,
            "org",
            "run",
            node,
            result as never,
            () => NOW,
            "job-1",
            claim,
          );
        } catch {
          lancou = true;
        }
        expect(lancou || escreveuForaDoDiario(db) === 0).toBe(true);
      },
    );

  it("skipped e deferred do envio vão ao DIÁRIO (com job e claim), nunca ao caminho legado", async () => {
    const skipped = mkDb("send");
    await completeTurnForEnrollment(
      skipped.db,
      "org",
      "run",
      "send",
      { kind: "skipped", reason: "opt_out" } as never,
      () => NOW,
      "job-1",
      claim,
    );
    expect(skipped.completeSkipped).toHaveBeenCalledTimes(1);
    expect(skipped.completeSkipped.mock.calls[0]!.slice(1)).toEqual(["job-1", "opt_out", claim]);
    expect(escreveuForaDoDiario(skipped.db)).toBe(0);

    const until = new Date("2026-10-20T10:00:00Z");
    const deferred = mkDb("send");
    await completeTurnForEnrollment(
      deferred.db,
      "org",
      "run",
      "send",
      { kind: "deferred", until, reason: "janela" } as never,
      () => NOW,
      "job-1",
      claim,
    );
    expect(deferred.deferSend).toHaveBeenCalledTimes(1);
    expect(deferred.deferSend.mock.calls[0]!.slice(1, 3)).toEqual(["job-1", until]);
    expect(escreveuForaDoDiario(deferred.db)).toBe(0);
  });
});
