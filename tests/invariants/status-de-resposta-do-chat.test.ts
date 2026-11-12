import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

describe("categorias do chat por carimbos reais", () => {
  it("distingue primeiro contato, retorno, saída sem entrada, empate e fechamento", () => {
    const resultado = sql(`
      select public.status_do_chat(jsonb_populate_record(null::public.conversations, x))
      from jsonb_array_elements('[
        {"status":"open","is_group":false,"last_inbound_at":"2026-10-16T10:00:00Z"},
        {"status":"claimed","is_group":false,"last_inbound_at":"2026-10-16T12:00:00Z","last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"ai_handling","is_group":false,"last_inbound_at":"2026-10-16T10:00:00Z","last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"open","is_group":false,"last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"open","is_group":false,"last_inbound_at":"2026-10-16T11:00:00Z","last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"closed","is_group":false,"last_inbound_at":"2026-10-16T12:00:00Z","last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"archived","is_group":false}
      ]'::jsonb) x;
    `);
    expect(resultado.split("\n")).toEqual([
      "sem_resposta",
      "em_espera",
      "em_aberto",
      "em_aberto",
      "em_aberto",
      "fechadas",
      "fechadas",
    ]);
  });

  it("grupo e conversa ainda sem mensagem não geram pendência de resposta", () => {
    expect(
      sql(`select count(*) from (
      select public.status_do_chat(jsonb_populate_record(null::public.conversations, x)) as categoria
      from jsonb_array_elements('[
        {"status":"open","is_group":true,"last_inbound_at":"2026-10-16T12:00:00Z","last_outbound_at":"2026-10-16T11:00:00Z"},
        {"status":"open","is_group":false}
      ]'::jsonb) x
    ) c where categoria is not null;`),
    ).toBe("0");
  });

  it("não eleva privilégios e recusa execução anônima", () => {
    expect(
      sql(
        `select prosecdef from pg_proc where oid = 'public.status_do_chat(public.conversations)'::regprocedure;`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select has_function_privilege('anon', 'public.status_do_chat(public.conversations)', 'execute');`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select has_function_privilege('authenticated', 'public.status_do_chat(public.conversations)', 'execute');`,
      ),
    ).toBe("t");
  });
});
