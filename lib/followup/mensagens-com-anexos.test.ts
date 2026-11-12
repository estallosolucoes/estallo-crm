import { describe, expect, it } from "vitest";

import {
  anexoPertenceAoFluxoDaOrg,
  destinoDoAnexoNaConversa,
  itemDoFluxoSchema,
} from "@/lib/agent-engine/agent/anexos-do-fluxo";

import { actionConfigSchema, flowGraphSchema, itemDeEnvioSchema, waitConfigSchema } from "./graph-schema";
import { validateFlowForPublish } from "./validate-publish";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const audio = {
  kind: "audio" as const,
  path: `${ORG}/flow-assets/33333333-3333-4333-8333-333333333333/audio.ogg`,
  mime: "audio/ogg",
  filename: "audio.ogg",
  size_bytes: 78_000,
};

describe("bloco de mensagens: contrato", () => {
  it("aceita texto + áudio + texto, na ordem", () => {
    const r = actionConfigSchema.safeParse({
      mode: "messages",
      items: [{ kind: "text", body: "Oi" }, audio, { kind: "text", body: "Fico no seu aguardo!!" }],
    });
    expect(r.success).toBe(true);
  });

  it("recusa lista vazia, texto vazio, mais de 10 envios e anexo sem arquivo", () => {
    expect(actionConfigSchema.safeParse({ mode: "messages", items: [] }).success).toBe(false);
    expect(actionConfigSchema.safeParse({ mode: "messages", items: [{ kind: "text", body: "" }] }).success).toBe(false);
    expect(
      actionConfigSchema.safeParse({ mode: "messages", items: Array.from({ length: 11 }, () => ({ kind: "text", body: "x" })) })
        .success,
    ).toBe(false);
    expect(itemDeEnvioSchema.safeParse({ kind: "image", mime: "image/png" }).success).toBe(false);
  });

  it("o esquema do agent-engine aceita o mesmo item que o motor enfileira", () => {
    expect(itemDoFluxoSchema.safeParse(audio).success).toBe(true);
    expect(itemDoFluxoSchema.safeParse({ kind: "text", body: "x" }).success).toBe(true);
    expect(itemDoFluxoSchema.safeParse({ kind: "gif", path: "x" }).success).toBe(false);
  });
});

describe("anexo do fluxo: posse e destino", () => {
  it("só o caminho da própria organização, na pasta de anexos, vale", () => {
    expect(anexoPertenceAoFluxoDaOrg(audio.path, ORG)).toBe(true);
    expect(anexoPertenceAoFluxoDaOrg(audio.path, "99999999-9999-4999-8999-999999999999")).toBe(false);
    expect(anexoPertenceAoFluxoDaOrg(`${ORG}/${CONVERSA}/audio.ogg`, ORG)).toBe(false);
    expect(anexoPertenceAoFluxoDaOrg(`${ORG}/flow-assets/../${CONVERSA}/x`, ORG)).toBe(false);
    expect(anexoPertenceAoFluxoDaOrg(`${ORG}/flow-assets/a\\b`, ORG)).toBe(false);
  });

  it("o destino é determinístico e cai na pasta da conversa", () => {
    const a = destinoDoAnexoNaConversa(ORG, CONVERSA, audio.path);
    expect(a).toBe(destinoDoAnexoNaConversa(ORG, CONVERSA, audio.path));
    expect(a.startsWith(`${ORG}/${CONVERSA}/`)).toBe(true);
    expect(a.endsWith("audio.ogg")).toBe(true);
    expect(destinoDoAnexoNaConversa(ORG, CONVERSA, `${ORG}/flow-assets/outro/audio.ogg`)).not.toBe(a);
  });
});

describe("espera: qualquer valor a partir de 1 segundo", () => {
  it("aceita 3 minutos, 30 segundos e 2 dias; recusa menos de 1 segundo", () => {
    for (const duration_ms of [180_000, 30_000, 1_000, 172_800_000])
      expect(waitConfigSchema.safeParse({ mode: "fixed", duration_ms }).success).toBe(true);
    expect(waitConfigSchema.safeParse({ mode: "fixed", duration_ms: 500 }).success).toBe(false);
  });
});

describe("fluxo da Indicação Pós-Venda publica", () => {
  it("agradecimento → espera de 3 min → produto → texto + áudio + texto", () => {
    const no = (id: string, type: string, config: unknown, y = 0) => ({ id, type, label: id, position: { x: 0, y }, config });
    const graph = flowGraphSchema.parse({
      nodes: [
        no("t", "trigger", {}),
        no("a", "action", { mode: "text", body: "Obrigado pela confirmação!!" }),
        no("w", "wait", { mode: "fixed", duration_ms: 180_000 }),
        no("c", "condition", {
          combinator: "and",
          branching: "per_check",
          checks: [
            { id: "vca", field: "product", op: "eq", value: "Coleta na Prática VCA" },
            { id: "micro", field: "product", op: "eq", value: "Micro na Prática" },
          ],
        }),
        no("m1", "action", { mode: "messages", items: [{ kind: "text", body: "Texto Coleta" }, audio, { kind: "text", body: "Fico no seu aguardo!!" }] }),
        no("m2", "action", { mode: "messages", items: [{ kind: "text", body: "Texto Micro" }, { ...audio, filename: "micro.ogg" }, { kind: "text", body: "Fico no seu aguardo!!" }] }),
        no("f1", "end", { outcome: "converted" }),
        no("f2", "end", { outcome: "converted" }),
        no("f3", "end", { outcome: "custom" }),
      ],
      edges: [
        ["e1", "t", "a", { type: "always" }],
        ["e2", "a", "w", { type: "always" }],
        ["e3", "w", "c", { type: "always" }],
        ["e4", "c", "m1", { type: "branch", branch_id: "vca" }],
        ["e5", "c", "m2", { type: "branch", branch_id: "micro" }],
        ["e6", "c", "f3", { type: "always" }],
        ["e7", "m1", "f1", { type: "always" }],
        ["e8", "m2", "f2", { type: "always" }],
      ].map(([id, source, target, condition]) => ({ id, source, target, priority: 0, condition })),
      execution_contract: 1,
    });
    expect(validateFlowForPublish(graph, {})).toEqual({ ok: true });
  });
});
