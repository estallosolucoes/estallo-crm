import { describe, expect, it } from "vitest";

import { abaDaConversa, contagensDepoisDe } from "./aba-da-conversa";

const T1 = "2026-10-30T10:00:00.000Z";
const T2 = "2026-10-30T11:00:00.000Z";

describe("aba da conversa (espelho de status_do_chat)", () => {
  it("classifica como o banco", () => {
    expect(abaDaConversa({ status: "open", last_inbound_at: T1, last_outbound_at: null })).toBe("pendentes");
    expect(abaDaConversa({ status: "open", last_inbound_at: T2, last_outbound_at: T1 })).toBe("em_espera");
    expect(abaDaConversa({ status: "open", last_inbound_at: T1, last_outbound_at: T2 })).toBe("em_aberto");
    expect(abaDaConversa({ status: "closed", last_inbound_at: T2, last_outbound_at: T1 })).toBe("closed");
    expect(abaDaConversa({ status: "open", is_group: true, last_inbound_at: T1, last_outbound_at: null })).toBeNull();
  });

  it("fechar move 1 de 'Em espera' para 'Fechadas' (27 → 26, 0 → 1)", () => {
    const antes = { all: 30, em_espera: 27, em_aberto: 2, closed: 0 };
    const conversa = { status: "open", last_inbound_at: T2, last_outbound_at: T1 };
    expect(contagensDepoisDe(antes, conversa, "closed")).toEqual({ all: 30, em_espera: 26, em_aberto: 2, closed: 1 });
  });

  it("reabrir faz o caminho inverso", () => {
    const antes = { em_aberto: 1, closed: 3 };
    const conversa = { status: "closed", last_inbound_at: T1, last_outbound_at: T2 };
    expect(contagensDepoisDe(antes, conversa, "open")).toEqual({ em_aberto: 2, closed: 2 });
  });
});
