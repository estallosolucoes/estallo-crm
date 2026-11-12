import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/sounds", () => ({ playSound: vi.fn() }));

import { playSound } from "@/lib/notifications/sounds";
import { emitNotification } from "@/lib/notifications/emit";

/**
 * O BIPE NÃO DEPENDE DA PERMISSÃO DE NOTIFICAÇÃO DO SISTEMA (17/10/2026).
 *
 * A verificação da permissão vinha ANTES do som: quem nunca concedeu (ou negou)
 * a notificação do SO não ouvia nada com a aba aberta — "o áudio de notificação
 * de mensagem não está funcionando". A permissão governa só a bandeja do SO.
 */
describe("emitNotification — som sem permissão do sistema", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("toca o bipe com a aba visível mesmo com a permissão negada, e não cria notificação", () => {
    const ctor = vi.fn();
    vi.stubGlobal("Notification", Object.assign(ctor, { permission: "denied" }));
    emitNotification({ kind: "message_inbound", title: "Maria", body: "oi", force: true });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("alerta desligado (sem force) continua mudo", () => {
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "denied" }));
    window.localStorage.setItem("alerts.enabled", "0");
    emitNotification({ kind: "message_inbound", title: "Maria", body: "oi" });
    expect(playSound).not.toHaveBeenCalled();
    window.localStorage.clear();
  });
});
