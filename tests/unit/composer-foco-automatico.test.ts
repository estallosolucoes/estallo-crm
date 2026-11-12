import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focarCampoDeMensagem } from "@/lib/inbox/foco-do-campo";

/**
 * FOCO AUTOMÁTICO NO CAMPO DE MENSAGEM (17/10/2026): abrir uma conversa ou
 * escolher "Responder a esta mensagem" deixa o cursor no campo, sem clique a
 * mais — mas nunca rouba foco de diálogo, nem abre o teclado do celular só por
 * abrir a conversa.
 */
function campo(texto = "", desabilitado = false): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  ta.value = texto;
  ta.disabled = desabilitado;
  document.body.appendChild(ta);
  return ta;
}

function celular(sim: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: sim && q === "(pointer: coarse)" })),
  );
  window.matchMedia = globalThis.matchMedia;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("focarCampoDeMensagem", () => {
  it("foca o campo e deixa o cursor no fim, sem apagar o texto", () => {
    celular(false);
    const ta = campo("rascunho já digitado");
    expect(focarCampoDeMensagem(ta, { mesmoNoCelular: false })).toBe(true);
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("rascunho já digitado");
    expect(ta.selectionStart).toBe(ta.value.length);
  });

  it("campo desabilitado (bloqueado, encerrada, só leitura) não recebe foco", () => {
    celular(false);
    const ta = campo("", true);
    expect(focarCampoDeMensagem(ta, { mesmoNoCelular: true })).toBe(false);
    expect(document.activeElement).not.toBe(ta);
  });

  it("com um diálogo aberto por cima, não rouba o foco dele", () => {
    celular(false);
    const dialogo = document.createElement("div");
    dialogo.setAttribute("role", "dialog");
    dialogo.setAttribute("data-state", "open");
    document.body.appendChild(dialogo);
    const ta = campo();
    expect(focarCampoDeMensagem(ta, { mesmoNoCelular: true })).toBe(false);
  });

  it("no celular, abrir a conversa não abre o teclado; responder abre", () => {
    celular(true);
    const ta = campo();
    expect(focarCampoDeMensagem(ta, { mesmoNoCelular: false })).toBe(false);
    expect(focarCampoDeMensagem(ta, { mesmoNoCelular: true })).toBe(true);
  });

  it("sem campo montado, não faz nada", () => {
    expect(focarCampoDeMensagem(null, { mesmoNoCelular: true })).toBe(false);
  });
});

describe("quem chama", () => {
  const composer = readFileSync("components/inbox/Composer.tsx", "utf8");

  it("o composer foca ao abrir/trocar de conversa e ao escolher responder", () => {
    expect(composer).toMatch(/\}, \[conversationId, active\]\);/);
    expect(composer).toMatch(/\}, \[respondendoId, active\]\);/);
    expect(composer).toMatch(/focarCampoDeMensagem\(taRef\.current, \{ mesmoNoCelular: true \}\)/);
  });

  it("o menu da bolha não devolve o foco à setinha depois de 'Responder'", () => {
    const bolha = readFileSync("components/inbox/MessageBubble.tsx", "utf8");
    expect(bolha).toMatch(/respondendoAoFechar\.current = true/);
    expect(bolha).toMatch(/onResponder\?\.\(message\)/);
  });
});

describe("menu de filtros cabe na tela", () => {
  const css = readFileSync("components/inbox/inbox.css", "utf8");
  const filtros = readFileSync("components/inbox/InboxFilters.tsx", "utf8");

  it("a altura máxima é o espaço livre medido pelo Radix, e só o miolo rola", () => {
    expect(css).toMatch(/max-height: var\(--radix-popover-content-available-height/);
    expect(css).toMatch(/\.ibx-filter-scroll \{[^}]*overflow-y: auto/);
    expect(filtros).toMatch(/collisionPadding=\{8\}/);
  });

  it("o botão Aplicar fica FORA da região que rola", () => {
    const inicio = filtros.indexOf('className="ibx-filter-scroll"');
    const botao = filtros.indexOf('data-testid="aplicar-filtros"');
    expect(inicio).toBeGreaterThan(-1);
    // Entre o início do miolo e o botão, as divs abertas e fechadas se anulam:
    // o miolo já fechou quando o botão aparece.
    const trecho = filtros.slice(inicio, botao);
    const abre = (trecho.match(/<div\b/g) ?? []).length;
    const fecha = (trecho.match(/<\/div>/g) ?? []).length;
    expect(fecha).toBeGreaterThanOrEqual(abre);
  });
});
