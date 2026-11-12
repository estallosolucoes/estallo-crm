import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas/messaging";

/**
 * A aba "Pendentes": o cliente escreveu e ninguém respondeu ainda.
 *
 * "Ninguém" é qualquer saída — pessoa pelo Inbox, automático ou envio pelo
 * celular —, porque todas gravam `last_outbound_at`. Encerradas e grupos ficam
 * de fora: grupo não espera resposta da equipe.
 *
 * Uma régua só para a lista e para o badge (`counts/route.ts`): a segunda
 * cópia sempre diverge, e badge que conta o que a aba não mostra manda o
 * atendente procurar trabalho que não existe.
 */
export function aplicarPendentes<
  C extends { filter: (coluna: string, operador: string, valor: unknown) => C },
>(consulta: C): C {
  return consulta
    .filter("last_inbound_at", "not.is", null)
    .filter("last_outbound_at", "is", null)
    .filter("is_group", "eq", false)
    .filter("status", "not.in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
}
