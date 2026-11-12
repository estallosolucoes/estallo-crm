/** Campo calculado do Postgres: compara os carimbos de entrada e saída antes da paginação.
 * Compartilhado entre listagem e contagens; leitura por RLS, sem alterar o ciclo do atendimento.
 */
export function aplicarStatusDoChat<
  C extends { filter: (coluna: string, operador: string, valor: unknown) => C },
>(consulta: C, status: "em_espera" | "em_aberto"): C {
  return consulta.filter("status_do_chat", "eq", status);
}
