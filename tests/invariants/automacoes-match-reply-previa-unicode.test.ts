import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { escolherResposta } from "@/lib/followup/node-handlers";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode com pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

// A previa que o banco grava e `left(new.body, 280)`: 280 CARACTERES (pontos de codigo), nao unidades UTF-16.
const previaDoBanco = async (body: string) =>
  ((await pool.query("select left($1::text, 280) as p", [body])).rows[0].p as string).trim();

describe("escolherResposta: casamento pela previa (left 280 do banco) com caracteres fora do BMP", () => {
  it("mensagem longa so com ASCII: casa pela previa", async () => {
    const body = "casa ".repeat(120).trim(); // ~599 caracteres
    expect(escolherResposta([{ id: "m1", body }], await previaDoBanco(body))?.id).toBe("m1");
  });

  it("mensagem longa com emoji (pontos de codigo > 280, unidades UTF-16 > 560): a previa do banco deve casar", async () => {
    const body = "😀".repeat(300); // 300 pontos de codigo / 600 unidades
    const previa = await previaDoBanco(body);
    process.stderr.write(`[unicode] previa=${Array.from(previa).length} pontos de codigo / ${previa.length} unidades; JS slice(0,280)=${Array.from(body.slice(0, 280)).length} pontos\n`);
    expect(escolherResposta([{ id: "m1", body }], previa)?.id).toBe("m1");
  });

  it("texto com emoji no comeco e >280 pontos de codigo no total (caso realista de WhatsApp)", async () => {
    const body = "Oi! 😀 " + "palavra ".repeat(60) + "fim 🙏 " + "x".repeat(50);
    expect(Array.from(body).length).toBeGreaterThan(280);
    const previa = await previaDoBanco(body);
    expect(escolherResposta([{ id: "m1", body }], previa)?.id).toBe("m1");
  });

  it("duas mensagens longas com os mesmos 280 primeiros caracteres e finais diferentes: nenhuma (o tick decide pelo banco)", async () => {
    const base = "a".repeat(300);
    const antiga = { id: "antiga", body: base + " fim A" };
    const nova = { id: "nova", body: base + " fim B" };
    const previa = await previaDoBanco(antiga.body);
    const escolhida = escolherResposta([nova, antiga], previa)?.id; // mais nova primeiro
    process.stderr.write(`[prefixo igual] webhook era da ANTIGA; escolhida=${escolhida}\n`);
    expect(escolhida).toBeUndefined();
  });
});
