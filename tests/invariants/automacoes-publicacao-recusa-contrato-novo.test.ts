import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

// Migration 0709 (troca a guarda da 0707): a função que cria versão publicada aceita o contrato 1 e
// recusa qualquer outro valor de `execution_contract` (defesa em profundidade: o validador da rota já
// recusa, mas esta função é a única porta que cria versão publicada).
const publicar = (pointer: string, graph: unknown) =>
  `select fn_publish_followup_flow_version('${GOV_ORG}'::uuid, '${pointer}'::uuid, '${JSON.stringify(graph)}'::jsonb, null)`;

async function ponteiro(): Promise<string> {
  const id = randomUUID();
  sql(
    `insert into public.followup_flow_pointers (id, organization_id, name, status) values ('${id}', '${GOV_ORG}', 'Publicação ${id}', 'draft')`,
  );
  return id;
}

const versoes = (pointer: string) =>
  Number(
    lastLine(
      sql(`select count(*) from public.followup_flow_versions where pointer_id = '${pointer}'`),
    ),
  );

beforeAll(() => {
  seedGov();
});

describe("publicar fluxo: a função aceita só o contrato de execução 1", () => {
  it("controle positivo: grafo legado (sem a chave) publica e vira a versão ativa", async () => {
    const pointer = await ponteiro();
    const novo = lastLine(sql(publicar(pointer, { nodes: [], edges: [] })));
    expect(novo).toMatch(/^[0-9a-f-]{36}$/);
    expect(versoes(pointer)).toBe(1);
    expect(
      lastLine(
        sql(`select active_version_id from public.followup_flow_pointers where id = '${pointer}'`),
      ),
    ).toBe(novo);
  });

  it("grafo com execution_contract=1 publica e vira a versão ativa", async () => {
    const pointer = await ponteiro();
    const novo = lastLine(sql(publicar(pointer, { nodes: [], edges: [], execution_contract: 1 })));
    expect(novo).toMatch(/^[0-9a-f-]{36}$/);
    expect(versoes(pointer)).toBe(1);
  });

  it.each([0, 2, null, "1", false])(
    "grafo com execution_contract=%j é recusado e NADA é gravado",
    async (valor) => {
      const pointer = await ponteiro();
      expect(() =>
        sql(publicar(pointer, { nodes: [], edges: [], execution_contract: valor })),
      ).toThrow(/execution_contract_invalid/);
      expect(versoes(pointer)).toBe(0);
      expect(
        lastLine(
          sql(
            `select active_version_id is null from public.followup_flow_pointers where id = '${pointer}'`,
          ),
        ),
      ).toBe("t");
    },
  );

  it("só a chave do TOPO do grafo conta: execution_contract aninhado num nó não é o marcador e publica", async () => {
    const pointer = await ponteiro();
    const grafo = {
      nodes: [{ id: "n", type: "end", config: { execution_contract: 1 } }],
      edges: [],
    };
    expect(lastLine(sql(publicar(pointer, grafo)))).toMatch(/^[0-9a-f-]{36}$/);
    expect(versoes(pointer)).toBe(1);
  });

  it("a guarda vem ANTES de achar o ponteiro: ponteiro inexistente continua dando pointer_not_found", () => {
    expect(() => sql(publicar(randomUUID(), { nodes: [] }))).toThrow(/pointer_not_found/);
  });

  it("a migration 0709 e o bloco do baseline são idênticos (sem comentários) e reaplicáveis sem mudar a ACL", () => {
    const migration = readFileSync(
      "supabase/migrations/20261030100000_0709_publicacao_aceita_contrato_de_execucao_1.sql",
      "utf8",
    );
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const ini = baseline.lastIndexOf("-- ---- Publish accepts execution contract 1 (migration 0709)");
    expect(ini).toBeGreaterThan(0);
    const strip = (t: string) =>
      t
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim();
    // O bloco termina no próximo cabeçalho do apêndice.
    const fim = baseline.indexOf("\n-- ---- ", ini + 1);
    expect(strip(baseline.slice(ini, fim + 1))).toBe(strip(migration));
    sql(migration);
    sql(migration);
    const pode = (role: string) =>
      lastLine(
        sql(
          `select has_function_privilege('${role}', 'public.fn_publish_followup_flow_version(uuid,uuid,jsonb,uuid)', 'execute')`,
        ),
      );
    expect([pode("service_role"), pode("anon"), pode("authenticated")]).toEqual(["t", "f", "f"]);
  });

  it("os privilégios foram preservados: só service_role executa (anon e authenticated, não)", () => {
    const pode = (role: string) =>
      lastLine(
        sql(
          `select has_function_privilege('${role}', 'public.fn_publish_followup_flow_version(uuid,uuid,jsonb,uuid)', 'execute')`,
        ),
      );
    expect(pode("service_role")).toBe("t");
    expect(pode("anon")).toBe("f");
    expect(pode("authenticated")).toBe("f");
  });
});
