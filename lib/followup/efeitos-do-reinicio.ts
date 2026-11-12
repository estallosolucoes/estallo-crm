/**
 * Quais blocos de um fluxo podem REPETIR um efeito quando a execução é reiniciada do começo. Mostrado antes da
 * confirmação: reiniciar é execução nova, então mensagem, tarefa, movimento de etapa e etiqueta acontecem de novo.
 *
 * `jaAconteceu` marca o bloco que a execução ORIGINAL concluiu (ou tentou) — é o que de fato vai se repetir; os
 * demais só acontecem se o novo caminho passar por eles. Não decide nada: é informação para quem confirma.
 */
export const TIPOS_COM_EFEITO = new Set([
  "action", // envia mensagem
  "collect", // faz pergunta ao contato
  "skill", // pode agir no CRM / falar com o contato
  "internal_task", // cria tarefa
  "move_lead", // move o negócio de etapa
  "edit_lead_tag", // grava etiqueta
  "assign_lead_owner", // troca o responsável do negócio
  "add_note", // registra nota interna
  "update_lead_field", // grava campo do negócio
  "lead_product", // acrescenta ou tira produto do negócio
  "http_request", // chama um sistema externo
  "find_or_create_contact", // pode criar contato
  "find_or_create_lead", // pode criar negócio
]);

export interface BlocoComEfeito {
  id: string;
  rotulo: string;
  tipo: string;
  jaAconteceu: boolean;
}

export function blocosComEfeito(
  nos: ReadonlyArray<{ id: string; rotulo: string; tipo: string }>,
  passos: ReadonlyArray<{ node_id: string; status: string }>,
): BlocoComEfeito[] {
  const feitos = new Set(passos.filter((p) => p.status === "succeeded" || p.status === "failed").map((p) => p.node_id));
  return nos
    .filter((n) => TIPOS_COM_EFEITO.has(n.tipo))
    .map((n) => ({ id: n.id, rotulo: n.rotulo, tipo: n.tipo, jaAconteceu: feitos.has(n.id) }))
    .sort((a, b) => Number(b.jaAconteceu) - Number(a.jaAconteceu));
}
