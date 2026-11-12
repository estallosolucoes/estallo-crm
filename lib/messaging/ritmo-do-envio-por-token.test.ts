import { describe, expect, it, vi } from "vitest";

import { segurarEnvioPorToken, type DepsDoRitmo } from "./ritmo-do-envio-por-token";
import { CHANNEL_CAPABILITIES, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const ORG = "org-1";
// Um provider que TEM risco de banimento (o padrão da casa) e um que não tem — achados pela matriz, sem nomear nenhum.
const COM_RISCO: string = DEFAULT_CHANNEL_PROVIDER;
const SEM_RISCO: string = Object.entries(CHANNEL_CAPABILITIES).find(([, c]) => !c.banRisk)![0];

function deps(canal: { channelSessionId: string; provider: string | null } | null) {
  const esperar = vi.fn(async () => {});
  const d: DepsDoRitmo = {
    lerCanalDaConversa: vi.fn(async () => canal),
    lerCanalDaSessao: vi.fn(async () => canal),
    esperar,
  };
  return { d, esperar };
}

describe("segurarEnvioPorToken — o ritmo fixo do número", () => {
  it("canal sem API oficial: espera o ritmo do número da conversa", async () => {
    const { d, esperar } = deps({ channelSessionId: "sess-1", provider: COM_RISCO });
    await segurarEnvioPorToken(d, { organizationId: ORG, conversationId: "c-1", requestId: "r" });
    expect(esperar).toHaveBeenCalledWith("sess-1");
  });

  it("por sessão do canal (início de conversa): espera o ritmo do mesmo número", async () => {
    const { d, esperar } = deps({ channelSessionId: "sess-2", provider: COM_RISCO });
    await segurarEnvioPorToken(d, { organizationId: ORG, channelSessionId: "sess-2", requestId: "r" });
    expect(esperar).toHaveBeenCalledWith("sess-2");
  });

  it("canal oficial (sem risco de banimento): passa direto", async () => {
    const { d, esperar } = deps({ channelSessionId: "sess-3", provider: SEM_RISCO });
    await segurarEnvioPorToken(d, { organizationId: ORG, conversationId: "c-3", requestId: "r" });
    expect(esperar).not.toHaveBeenCalled();
  });

  it("conversa que não é desta organização: não há o que esperar (o handler responde 404)", async () => {
    const { d, esperar } = deps(null);
    await segurarEnvioPorToken(d, { organizationId: ORG, conversationId: "c-x", requestId: "r" });
    expect(esperar).not.toHaveBeenCalled();
  });
});
