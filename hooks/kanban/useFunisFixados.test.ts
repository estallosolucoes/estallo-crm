import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const org = vi.hoisted(() => ({ atual: "org-estallo" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: { orgId: org.atual } }) }));

import { chaveDosFunisFixados, useFunisFixados } from "./useFunisFixados";

beforeEach(() => {
  window.localStorage.clear();
  org.atual = "org-estallo";
});

describe("funis fixados", () => {
  it("o funil fixado numa organização NÃO aparece na outra", () => {
    const { result, rerender } = renderHook(() => useFunisFixados());
    act(() => {
      result.current.alternar({ id: "f-1", nome: "Vendas Estallo" });
    });
    expect(result.current.fixados.map((f) => f.id)).toEqual(["f-1"]);
    expect(window.localStorage.getItem(chaveDosFunisFixados("org-estallo"))).toContain("f-1");

    org.atual = "org-pratica";
    rerender();
    expect(result.current.fixados).toEqual([]);

    org.atual = "org-estallo";
    rerender();
    expect(result.current.fixados.map((f) => f.id)).toEqual(["f-1"]);
  });
});
