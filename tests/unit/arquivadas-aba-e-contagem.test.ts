/**
 * O Estallo tirou o "Arquivar" do inbox: sem botão, sem aba "Arquivadas".
 *
 * As conversas que já estavam arquivadas não somem: passam a morar na aba
 * "Fechadas". Para isso a lista da aba e o badge dela precisam pedir o MESMO
 * par de status — senão o badge conta o que a lista não mostra.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tabToFilter } from "@/components/inbox/InboxLayout";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas/messaging";

const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("aba Fechadas inclui as arquivadas de antes", () => {
  it("a lista pede closed + archived", () => {
    expect(tabToFilter("closed")).toEqual({ status: ["closed", "archived"] });
  });

  it("o badge conta o mesmo par que a lista", () => {
    expect([...CONVERSATION_TERMINAL_STATUSES].sort()).toEqual(["archived", "closed"]);
    const rota = fonte("app/api/v1/conversations/counts/route.ts");
    expect(rota).toMatch(/\.in\("status",\s*\[\.\.\.CONVERSATION_TERMINAL_STATUSES\]\)/);
  });
});

describe("sem Arquivar na tela", () => {
  it("não há aba Arquivadas", () => {
    expect(fonte("components/inbox/InboxFilters.tsx")).not.toContain('value: "archived"');
  });

  it("o cabeçalho não oferece Arquivar", () => {
    const header = fonte("components/inbox/ConversationHeader.tsx");
    expect(header).not.toContain('t("Arquivar")');
    expect(header).not.toContain("useArchiveConversation");
  });
});
