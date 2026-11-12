import { describe, expect, it } from "vitest";

import { mapearDados } from "./mapear-dados";

const SAIDAS = {
  tag1: { tags: ["vip", "quente"], added_tags: [], lead_id: null },
  task1: { task_id: "t-1", contact_id: "c-1", lead_id: "l-1" },
  cond: { matched: true, branch_id: "b1", checks: [] },
};

describe("mapearDados", () => {
  it("referência sozinha preserva o tipo; composição monta texto", () => {
    const r = mapearDados(
      [
        { name: "etiquetas", value: "{{nodes.tag1.tags}}", type: "list" },
        { name: "resumo", value: "Tarefa {{nodes.task1.task_id}} — {{nodes.tag1.tags}}", type: "text" },
      ],
      SAIDAS,
    );
    expect(r).toEqual({ ok: true, fields: { etiquetas: ["vip", "quente"], resumo: "Tarefa t-1 — vip, quente" } });
  });

  it("ausente, null e lista vazia são diferentes", () => {
    // null lido sozinho segue null
    expect(mapearDados([{ name: "lead", value: "{{nodes.tag1.lead_id}}", type: "text" }], SAIDAS)).toEqual({
      ok: true,
      fields: { lead: null },
    });
    // lista vazia sozinha segue lista vazia
    expect(mapearDados([{ name: "add", value: "{{nodes.tag1.added_tags}}", type: "list" }], SAIDAS)).toEqual({
      ok: true,
      fields: { add: [] },
    });
    // ausente sem fallback falha com explicação
    const r = mapearDados([{ name: "x", value: "{{nodes.task1.nao_existe}}", type: "text" }], SAIDAS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("{{nodes.task1.nao_existe}}");
    // na composição, lista vazia não vira texto: conta como ausente
    expect(mapearDados([{ name: "x", value: "a {{nodes.tag1.added_tags}}", type: "text" }], SAIDAS).ok).toBe(false);
  });

  it("fallback só quando configurado, e passa pela conversão", () => {
    expect(
      mapearDados([{ name: "n", value: "{{nodes.zzz.valor}}", type: "number", fallback: "0" }], SAIDAS),
    ).toEqual({ ok: true, fields: { n: 0 } });
    expect(
      mapearDados([{ name: "n", value: "{{nodes.zzz.valor}}", type: "number", fallback: "abc" }], SAIDAS).ok,
    ).toBe(false);
  });

  it("conversões explícitas: número brasileiro, sim/não, lista de texto", () => {
    const r = mapearDados(
      [
        { name: "valor", value: "1.234,50", type: "number" },
        { name: "casou", value: "{{nodes.cond.matched}}", type: "boolean" },
        { name: "sim", value: "Sim", type: "boolean" },
        { name: "itens", value: "a, b,,c", type: "list" },
      ],
      SAIDAS,
    );
    expect(r).toEqual({ ok: true, fields: { valor: 1234.5, casou: true, sim: true, itens: ["a", "b", "c"] } });
    expect(mapearDados([{ name: "v", value: "talvez", type: "boolean" }], SAIDAS).ok).toBe(false);
    expect(mapearDados([{ name: "v", value: "doze", type: "number" }], SAIDAS).ok).toBe(false);
  });

  it("não sai do protótipo nem lê bloco que não está nas saídas", () => {
    expect(mapearDados([{ name: "v", value: "{{nodes.task1.constructor}}", type: "text" }], SAIDAS).ok).toBe(false);
    expect(mapearDados([{ name: "v", value: "{{nodes.toString.length}}", type: "text" }], SAIDAS).ok).toBe(false);
  });
});
