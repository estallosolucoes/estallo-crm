import { render, screen } from "@testing-library/react";
import { format, subDays } from "date-fns";
import { describe, expect, it, vi } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A ESPERA DA FILA SAI DA MESMA RÉGUA QUE ORDENA A LISTA (#990, #464).
 *
 * Desde o redesenho do Inbox (16/10/2026, modelo do dono) o canto da linha
 * mostra SEMPRE a hora da última mensagem, e a espera foi para a linha de
 * operação, por extenso: "3º na fila · Espera de 9d". O que esta suíte prende
 * não mudou: a espera é contada de `awaiting_since` (a mensagem mais antiga sem
 * resposta) — nunca da última do cliente, da atividade ou da criação — com o
 * mesmo fallback da régua (`esperaDaConversa`).
 */

vi.mock("@/components/inbox/AcoesDaConversa", () => ({ AcoesDaConversa: () => null }));

const agora = new Date();
const espera = subDays(agora, 9).toISOString();
const ultimaDoCliente = subDays(agora, 1).toISOString();
const atividade = subDays(agora, 12).toISOString();
const criacao = subDays(agora, 300).toISOString();

const horaDaAtividade = format(new Date(atividade), "dd/MM");

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  last_message_at: atividade,
  last_inbound_at: ultimaDoCliente,
  awaiting_since: espera,
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: criacao,
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

const pintar = (conv: ConversationWithContact) =>
  render(
    <ConversationListItem
      conversation={conv}
      isSelected={false}
      onSelect={() => {}}
      mostrarCanal={false}
    />,
  );

describe("Inbox sem posição na fila", () => {
  it("mostra a última atividade sem posição nem linha de espera", () => {
    pintar(base);
    expect(screen.getByText(horaDaAtividade)).toBeInTheDocument();
    expect(screen.queryByText(/na fila/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Espera de/)).not.toBeInTheDocument();
  });
});
