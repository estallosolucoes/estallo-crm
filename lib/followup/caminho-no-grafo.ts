/**
 * O CAMINHO de uma execução projetado SOBRE o grafo do fluxo: o estado de cada bloco visitado e quais ligações foram
 * percorridas. É o que o canvas de inspeção pinta; o que não aparece aqui é "não percorrido".
 *
 * Uma ligação conta como percorrida quando dois passos CONSECUTIVOS a atravessam. Entre dois blocos pode haver mais de
 * uma ligação (uma por saída): vale a que casa com a saída que o passo registrou (`branch_id`); sem essa informação, a
 * ligação "sempre". Se ainda assim não der para decidir, nenhuma é pintada — melhor um trecho sem destaque do que
 * afirmar um caminho que o diário não prova.
 */
import type { PassoDaExecucao } from "./passos-da-execucao";

export interface ArestaDoGrafo {
  id: string;
  source: string;
  target: string;
  condition?: { type: string; branch_id?: string };
}

export interface CaminhoNoGrafo {
  /** Estado do ÚLTIMO passo de cada bloco visitado (numa volta, a visita mais recente vale). */
  estadoDoNo: Map<string, string>;
  arestasPercorridas: Set<string>;
}

export function projetarCaminho(passos: PassoDaExecucao[], arestas: ArestaDoGrafo[]): CaminhoNoGrafo {
  const estadoDoNo = new Map<string, string>();
  for (const p of passos) estadoDoNo.set(p.node_id, p.status);

  const arestasPercorridas = new Set<string>();
  for (let i = 0; i + 1 < passos.length; i++) {
    const de = passos[i]!;
    const para = passos[i + 1]!;
    const candidatas = arestas.filter((a) => a.source === de.node_id && a.target === para.node_id);
    if (candidatas.length === 0) continue;
    const exata =
      candidatas.find((a) => a.condition?.type === "branch" && de.branch_id !== null && a.condition.branch_id === de.branch_id) ??
      (de.branch_id === null || de.branch_id === "else" ? candidatas.find((a) => a.condition?.type === "always") : undefined) ??
      (candidatas.length === 1 ? candidatas[0] : undefined);
    if (exata) arestasPercorridas.add(exata.id);
  }
  return { estadoDoNo, arestasPercorridas };
}
