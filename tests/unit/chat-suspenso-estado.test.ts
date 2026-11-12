import { describe, expect, it } from "vitest";
import {
  abrirChat,
  fecharChat,
  MAXIMO_DE_CHATS,
  substituirChat,
} from "@/components/chat-suspenso/ChatSuspensoContext";

const vazio = { abertos: [] as string[], ativo: null as string | null, minimizado: false };

describe("chat suspenso — estado", () => {
  it("abrir um contato já aberto não duplica: só traz à frente e restaura", () => {
    const e = abrirChat(abrirChat(vazio, "a"), "b");
    const de_novo = abrirChat({ ...e, minimizado: true }, "a");
    expect(de_novo.abertos).toEqual(["a", "b"]);
    expect(de_novo.ativo).toBe("a");
    expect(de_novo.minimizado).toBe(false);
  });

  it("passou do teto: sai o mais antigo que não está à vista", () => {
    let e = vazio;
    for (let i = 0; i < MAXIMO_DE_CHATS; i++) e = abrirChat(e, `c${i}`);
    e = { ...e, ativo: "c0" };
    const depois = abrirChat(e, "novo");
    expect(depois.abertos).toHaveLength(MAXIMO_DE_CHATS);
    expect(depois.abertos).toContain("c0");
    expect(depois.abertos).not.toContain("c1");
    expect(depois.ativo).toBe("novo");
  });

  it("fechar o ativo passa a vez ao último aberto; fechar o último esvazia", () => {
    const e = abrirChat(abrirChat(vazio, "a"), "b");
    const semB = fecharChat(e, "b");
    expect(semB.abertos).toEqual(["a"]);
    expect(semB.ativo).toBe("a");
    const vazioDeNovo = fecharChat(semB, "a");
    expect(vazioDeNovo.abertos).toEqual([]);
    expect(vazioDeNovo.ativo).toBeNull();
  });
});

describe("chat suspenso — troca de instância", () => {
  it("a conversa do outro número entra no LUGAR da atual e fica à vista", () => {
    const e = { abertos: ["a", "b", "c"], ativo: "b", minimizado: true };
    expect(substituirChat(e, "b", "b2")).toEqual({ abertos: ["a", "b2", "c"], ativo: "b2", minimizado: false });
  });

  it("se a conversa nova já estava aberta, a antiga só sai — sem duplicar", () => {
    const e = { abertos: ["a", "b", "c"], ativo: "b", minimizado: false };
    expect(substituirChat(e, "b", "c")).toEqual({ abertos: ["a", "c"], ativo: "c", minimizado: false });
  });
});
