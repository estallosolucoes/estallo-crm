/**
 * A PORTA DE /admin/cobranca. No Estallo o rótulo é «Planos e assinatura» e a entrada existe SEMPRE:
 * a oferta é do SaaS (planos demonstrativos), não de um módulo opcional que a instalação liga. No upstream
 * a entrada só aparecia com a chave `cobranca` ligada (spec da cobrança §9, §13); o fork tirou essa condição
 * do menu (`AdminSidebar`, item sem `modulo`), e este teste passou a vigiar o contrário.
 * A presença do href no menu é vigiada por `admin-navegacao-completude`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/dashboard" }));

import { AdminSidebar } from "@/components/admin/AdminSidebar";

afterEach(cleanup);

describe("menu do admin — Planos e assinatura", () => {
  it("sem módulo nenhum ligado, a entrada está lá (controle: Tenants também)", () => {
    render(<AdminSidebar userEmail="dono@x.test" modulosLigados={[]} />);
    expect(screen.getByRole("link", { name: "Planos e assinatura" }).getAttribute("href")).toBe("/admin/cobranca");
    expect(screen.getByRole("link", { name: "Tenants" })).toBeTruthy();
  });

  it("com a chave `cobranca` ligada, a entrada segue levando a /admin/cobranca", () => {
    render(<AdminSidebar userEmail="dono@x.test" modulosLigados={["cobranca"]} />);
    expect(screen.getByRole("link", { name: "Planos e assinatura" }).getAttribute("href")).toBe("/admin/cobranca");
  });
});
