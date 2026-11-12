"use client";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";

/**
 * As tags do contato com escrita OTIMISTA: o chip aparece (ou some) no clique,
 * e a gravação corre por trás. Antes o editor ficava desabilitado até o PATCH e
 * o refetch da lista de conversas voltarem — a tela parecia travada.
 *
 * Só a ÚLTIMA escrita decide o estado: cliques rápidos mandam a lista inteira a
 * cada vez, e a resposta de uma escrita velha não pode desfazer a mais nova.
 * Erro da última → volta ao que o servidor tem (o toast vem de `useUpdateContact`).
 * Sucesso da última → espera a lista de conversas ser relida e entrega a fonte de
 * volta ao servidor.
 */
export function useTagsDoContato(contactId: string, doServidor: string[]) {
  const qc = useQueryClient();
  const mutation = useUpdateContact(contactId);
  const [pendente, setPendente] = useState<{ contactId: string; tags: string[] } | null>(null);
  const sequencia = useRef(0);

  function aplicar(proximas: string[]) {
    const minha = ++sequencia.current;
    setPendente({ contactId, tags: proximas });
    mutation.mutate(
      { tags: proximas },
      {
        onError: () => {
          if (minha === sequencia.current) setPendente(null);
        },
        onSuccess: async () => {
          // `useUpdateContact` já invalidou; `cancelRefetch: false` pega carona
          // na releitura em voo em vez de disparar outra.
          await qc.refetchQueries({ queryKey: ["conversations"], type: "active" }, { cancelRefetch: false });
          if (minha === sequencia.current) setPendente(null);
        },
      },
    );
  }

  // Trocar de contato descarta o otimismo do anterior.
  const tags = pendente && pendente.contactId === contactId ? pendente.tags : doServidor;
  return { tags, aplicar };
}
