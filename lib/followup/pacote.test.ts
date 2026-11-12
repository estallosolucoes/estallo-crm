import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "./graph-schema";
import { importarPacote, lerPacote, montarPacote, segredosEmbutidos, uuidsCitados } from "./pacote";

const ETAPA_A = "11111111-1111-4111-8111-111111111111";
const ETAPA_B = "22222222-2222-4222-8222-222222222222";
const USUARIO_A = "33333333-3333-4333-8333-333333333333";
const USUARIO_B = "44444444-4444-4444-8444-444444444444";

const no = (id: string, type: string, config: unknown) => ({ id, type, label: id, position: { x: 1, y: 2 }, config });
const grafo = flowGraphSchema.parse({
  nodes: [
    no("t", "trigger", {}),
    no("mapa", "map_data", { fields: [{ name: "x", value: "fixo", type: "text" }] }),
    no("mover", "move_lead", { stage_id: ETAPA_A }),
    no("dono", "assign_lead_owner", { usuario_id: USUARIO_A }),
    no("nota", "add_note", { destino: "lead_timeline", texto: "Campo: {{nodes.mapa.fields.x}}" }),
    no("f", "end", { outcome: "converted" }),
  ],
  edges: [
    { id: "e1", source: "t", target: "mapa", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "mapa", target: "mover", priority: 0, condition: { type: "always" } },
    { id: "e3", source: "mover", target: "dono", priority: 0, condition: { type: "always" } },
    { id: "e4", source: "dono", target: "nota", priority: 0, condition: { type: "always" } },
    { id: "e5", source: "nota", target: "f", priority: 0, condition: { type: "always" } },
  ],
});
const pacote = montarPacote({
  nome: "Fluxo A",
  superficie: "followup",
  handoff_policy: "pause",
  trigger_config: { kind: "manual" },
  grafo,
  origem: { tipo: "versao", versao_numero: 3, exportado_em: "2026-11-12T00:00:00Z" },
  dependencias: [
    { id: ETAPA_A, tipo: "etapa", nome: "Proposta · Vendas" },
    { id: USUARIO_A, tipo: "usuario", nome: "Ana" },
  ],
});

let seq = 0;
const novoId = () => `n${++seq}`;

describe("pacote de automação", () => {
  it("acha as referências externas citadas nas configurações", () => {
    expect(uuidsCitados(grafo.nodes.map((n) => n.config)).sort()).toEqual([ETAPA_A, USUARIO_A].sort());
  });

  it("detecta segredo embutido (a exportação recusa)", () => {
    expect(segredosEmbutidos({ a: { b: "Authorization: Bearer abcdefghijklmnop123" } })).toEqual([
      { caminho: "a.b", tipo: "um token Bearer" },
    ]);
    expect(segredosEmbutidos(grafo)).toEqual([]);
  });

  it("lê o arquivo antes de escrever: formato, versão futura, JSON inválido, tamanho", () => {
    expect(lerPacote(JSON.stringify(pacote))).toMatchObject({ ok: true });
    expect(lerPacote("{")).toMatchObject({ ok: false });
    expect(lerPacote(JSON.stringify({ ...pacote, formato: "n8n" }))).toMatchObject({ ok: false });
    const futuro = lerPacote(JSON.stringify({ ...pacote, versao_do_formato: 99 }));
    expect(futuro.ok).toBe(false);
    if (!futuro.ok) expect(futuro.motivo).toContain("versão mais nova");
    expect(lerPacote("x".repeat(1_000_001))).toMatchObject({ ok: false });
  });

  it("sem destino para cada referência, não importa (nome igual não autoriza vínculo)", () => {
    const r = importarPacote(pacote, { [ETAPA_A]: ETAPA_B }, novoId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.pendentes?.map((p) => p.id)).toEqual([USUARIO_A]);
  });

  it("importa com ids de bloco novos, referências reescritas e ids externos remapeados", () => {
    seq = 0;
    const r = importarPacote(pacote, { [ETAPA_A]: ETAPA_B, [USUARIO_A]: USUARIO_B }, novoId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.grafo.nodes.map((n) => n.id);
    expect(ids.some((id) => ["t", "mapa", "mover"].includes(id))).toBe(false);
    const mapa = r.grafo.nodes.find((n) => n.type === "map_data")!;
    const nota = r.grafo.nodes.find((n) => n.type === "add_note")!;
    expect((nota.config as { texto: string }).texto).toBe(`Campo: {{nodes.${mapa.id}.fields.x}}`);
    expect(r.grafo.nodes.find((n) => n.type === "move_lead")!.config).toEqual({ stage_id: ETAPA_B });
    expect(r.grafo.nodes.find((n) => n.type === "assign_lead_owner")!.config).toEqual({ usuario_id: USUARIO_B });
    // arestas apontam para os ids novos, posições preservadas
    expect(r.grafo.edges.every((e) => ids.includes(e.source) && ids.includes(e.target))).toBe(true);
    expect(r.grafo.nodes[0]!.position).toEqual({ x: 1, y: 2 });
  });

  it("exportar de novo o fluxo importado preserva a semântica (fora ids e metadados)", () => {
    const ida = importarPacote(pacote, { [ETAPA_A]: ETAPA_A, [USUARIO_A]: USUARIO_A }, novoId);
    if (!ida.ok) throw new Error("falhou");
    const semIds = (g: typeof grafo) =>
      g.nodes.map((n) => ({ type: n.type, label: n.label, config: JSON.stringify(n.config).replace(/nodes\.[^.]+\./g, "nodes.X.") }));
    expect(semIds(ida.grafo)).toEqual(semIds(grafo));
  });
});

describe("conferência do remapeamento (o destino é do tenant e do mesmo tipo)", () => {
  it("recusa destino de outra organização, tipo trocado e referência desconhecida; aceita o certo", async () => {
    const { problemaDoMapa } = await import("./referencias-do-pacote");
    const destino = {
      etapa: [{ id: ETAPA_B, nome: "Proposta · Vendas" }],
      funil: [],
      usuario: [{ id: USUARIO_B, nome: "Bia" }],
      tipo_de_agenda: [],
      agente: [],
      conexao_http: [],
    };
    const deps = pacote.dependencias;
    expect(problemaDoMapa(deps, { [ETAPA_A]: ETAPA_B, [USUARIO_A]: USUARIO_B }, destino)).toBeNull();
    // id que não está entre os candidatos DESTA organização (ex.: o id da origem)
    expect(problemaDoMapa(deps, { [ETAPA_A]: ETAPA_A, [USUARIO_A]: USUARIO_B }, destino)).toContain("não existe nesta organização");
    // etapa remapeada para um usuário: tipo trocado
    expect(problemaDoMapa(deps, { [ETAPA_A]: USUARIO_B, [USUARIO_A]: USUARIO_B }, destino)).toContain("não existe nesta organização");
    expect(problemaDoMapa([{ id: "x", tipo: "desconhecido", nome: "x" }], {}, destino)).toContain("não sabe remapear");
  });
});
