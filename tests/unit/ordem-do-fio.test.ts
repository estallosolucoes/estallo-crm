import { describe, expect, it } from "vitest";
import { compararMensagens, instanteOtimista } from "@/lib/inbox/ordem-do-fio";
import { mergeThreadItems } from "@/components/inbox/ChatThread";

/**
 * A ORDEM DO FIO (17/10/2026): "a mensagem que eu envio aparece acima de
 * mensagens que já estavam na conversa".
 */
describe("instanteOtimista", () => {
  it("relógio do navegador ATRASADO: a enviada ainda vem depois da última conhecida", () => {
    // Medido: a máquina de um atendente estava 37 min atrasada.
    const ultima = "2026-10-17T13:20:00.000Z";
    const agoraAtrasado = Date.parse("2026-10-17T12:43:00.000Z");
    const instante = instanteOtimista([{ sent_at: ultima }], agoraAtrasado);
    expect(Date.parse(instante)).toBeGreaterThan(Date.parse(ultima));
  });

  it("relógio certo: usa o agora", () => {
    const agora = Date.parse("2026-10-17T13:30:00.000Z");
    expect(instanteOtimista([{ sent_at: "2026-10-17T13:20:00.000Z" }], agora)).toBe(
      new Date(agora).toISOString(),
    );
  });

  it("conversa vazia: usa o agora", () => {
    const agora = Date.parse("2026-10-17T13:30:00.000Z");
    expect(instanteOtimista([], agora)).toBe(new Date(agora).toISOString());
  });
});

describe("compararMensagens — desempate total", () => {
  it("mesmo sent_at (WhatsApp manda em segundos): vale a ordem de gravação", () => {
    const a = { id: "z", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:01.100Z" };
    const b = { id: "a", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:01.200Z" };
    expect([b, a].sort(compararMensagens).map((m) => m.id)).toEqual(["z", "a"]);
  });

  it("tudo empatado: o id decide, para a ordem não depender da página", () => {
    const x = { id: "b", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:00Z" };
    const y = { id: "a", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:00Z" };
    expect([x, y].sort(compararMensagens).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("o fio aplica o mesmo desempate, independente da ordem em que as páginas chegaram", () => {
    const msgs = [
      { id: "m2", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:02Z" },
      { id: "m1", sent_at: "2026-10-17T13:00:00Z", created_at: "2026-10-17T13:00:01Z" },
    ] as never;
    expect(mergeThreadItems(msgs, []).map((i) => i.data.id)).toEqual(["m1", "m2"]);
  });
});
