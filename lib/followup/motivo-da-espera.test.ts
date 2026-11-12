import { describe, expect, it } from "vitest";

import { motivoDaEspera, type EntradaDaEspera } from "./motivo-da-espera";

const t = (x: string) => x;
const fmt = (iso: string) => `<${iso}>`;
const base: EntradaDaEspera = {
  status: "active",
  next_eval_at: null,
  attempts: 0,
  max_attempts: 3,
  rotuloDoBlocoAtual: "Mensagem 1",
};

describe("motivoDaEspera", () => {
  it("esperando resposta: diz qual bloco e quando o fluxo segue sem ela", () => {
    const r = motivoDaEspera({ ...base, status: "waiting_reply", next_eval_at: "2026-11-06T10:00:00Z" }, t, fmt);
    expect(r).toContain("«Mensagem 1»");
    expect(r).toContain("<2026-11-06T10:00:00Z>");
  });
  it("tentativa pendente: mostra qual é e o limite", () => {
    const r = motivoDaEspera({ ...base, attempts: 2, next_eval_at: "2026-11-05T12:00:00Z" }, t, fmt);
    expect(r).toContain("(2/3)");
  });
  it("motor ocupado vence qualquer outra explicação do estado ativo", () => {
    expect(
      motivoDaEspera({ ...base, motor_ocupado: true, next_eval_at: "2026-11-05T12:00:00Z" }, t, fmt),
    ).toContain("processando");
  });
  it("pausas dizem quem pausou", () => {
    expect(motivoDaEspera({ ...base, status: "paused_manual" }, t, fmt)).toContain("uma pessoa");
    expect(motivoDaEspera({ ...base, status: "paused_handoff" }, t, fmt)).toContain("atendente");
  });
  it("execução terminada, ou ativa sem horário: nada a explicar, nada inventado", () => {
    for (const status of ["completed", "cancelled", "dead"]) {
      expect(motivoDaEspera({ ...base, status }, t, fmt)).toBeNull();
    }
    expect(motivoDaEspera(base, t, fmt)).toBeNull();
  });
});
