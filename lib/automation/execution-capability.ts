/** Compartilhada com o worker: nenhuma porta envia usando um contrato indisponível. */
export const EXECUTION_CONTRACT_AVAILABLE = true;

/**
 * Tipos de nó que o diário do contrato 1 já conclui de ponta a ponta (resultado persistido e
 * avanço na mesma transação). Habilitar o contrato exige esta lista: nó fora dela ainda avançaria
 * pelo caminho legado, sem registrar o resultado, e por isso não pode ser publicado no contrato 1.
 * `collect` e `skill` são do executor de atendimento (conduzido pelo turno, não pelo relógio) e
 * ficam de fora. A captação do `match_reply` grava na transação do `completeDecision`; no modo
 * `confirm` a pergunta sai pelo trilho do turno (job ligado à tentativa) e o recibo do envio
 * (`completeConfirmationSend`) é que coloca a tentativa em espera.
 * A espera `smart` passa pelo diário: o turno `planned` do acionamento conclui por `completePlan`.
 */
export const NODES_INTEGRATED_IN_EXECUTION_CONTRACT: ReadonlySet<string> = new Set([
  "trigger",
  "condition",
  "wait",
  "repeat",
  "end",
  "action",
  "ai_classify",
  "match_reply",
  "internal_task",
  "edit_lead_tag",
  "move_lead",
  "map_data",
  "assign_lead_owner",
  "add_note",
  "update_lead_field",
  "lead_product",
  "http_request",
  "find_or_create_contact",
  "find_or_create_lead",
]);

export function executionContractProblem(
  enrollment: { execution_contract?: number | null },
  graph: { execution_contract?: number | null },
): "execution_contract_mismatch" | "execution_contract_unavailable" | null {
  const executionContract = enrollment.execution_contract ?? 0;
  if (executionContract !== (graph.execution_contract ?? 0)) return "execution_contract_mismatch";
  if (executionContract !== 0 && (executionContract !== 1 || !EXECUTION_CONTRACT_AVAILABLE)) {
    return "execution_contract_unavailable";
  }
  return null;
}
