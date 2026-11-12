/**
 * SIMULAR O CAMINHO no rascunho (Fase 6): percorre o grafo com dados de EXEMPLO e diz por onde a execução passaria e
 * o que cada bloco FARIA — sem banco, sem mensagem, sem tocar no CRM. Puro.
 *
 * - Condição: o avaliador real (`processNode`), com as etiquetas/etapa de exemplo e as saídas simuladas.
 * - Mapear dados: a regra real (`mapearDados`), sobre as saídas simuladas dos blocos anteriores.
 * - Resposta (texto) e Classificar (IA): quem testa ESCOLHE o ramo (a simulação não inventa a resposta do cliente).
 * - Blocos com efeito (mensagem, tarefa, tag, mover, nota, campo, responsável): «faria …», com saída de exemplo.
 * - Esperas: o tempo é considerado cumprido.
 *
 * Os exemplos ficam aqui e na tela; nenhuma execução publicada os lê.
 */
import { branchOfSelectedEdge, processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";
import { ON_ERROR_BRANCH_ID, type FlowEdge, type FlowGraph, type FlowNode } from "./graph-schema";
import { resumoDoNo } from "./eventos-legiveis";
import { mapearDados } from "./mapear-dados";
import { previaDoTexto, saidaDeExemplo } from "./previa-do-texto";
import { textosDoBloco } from "./variaveis-de-blocos";

export interface PassoSimulado {
  no_id: string;
  rotulo: string;
  tipo: FlowNode["type"];
  /** O que o bloco faria (efeito PREVISTO, nada aconteceu). */
  previsto: string;
  /** O ramo tomado, quando o bloco escolhe caminho. */
  ramo: string | null;
  /** Texto que sairia (mensagem/nota/título), já com as variáveis de exemplo. */
  texto?: string;
  /** O bloco não conseguiria seguir (ex.: Mapear dados sem valor) — a simulação para aqui. */
  erro?: string;
}

export interface EntradaDaSimulacao {
  /** Etiquetas e etapa de exemplo do negócio. */
  fatos?: Partial<LeadFacts>;
  /** Ramo escolhido para cada bloco de resposta/classificação: `no_id → branch_id`. */
  escolhas?: Record<string, string>;
}

const ENROLLMENT_DE_EXEMPLO = {
  id: "simulacao",
  organization_id: "simulacao",
  contact_id: "simulacao",
  current_node_id: "",
  steps_taken: 0,
  status: "active",
} as unknown as EnrollmentRow;

const TETO_DE_PASSOS = 50;

function saidasDe(graph: FlowGraph): (id: string) => FlowEdge[] {
  const porOrigem = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) porOrigem.set(e.source, [...(porOrigem.get(e.source) ?? []), e]);
  return (id) => porOrigem.get(id) ?? [];
}

export function simularCaminho(graph: FlowGraph, entrada: EntradaDaSimulacao = {}): PassoSimulado[] {
  const fatos: LeadFacts = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null, ...entrada.fatos };
  const saidasDoNo = saidasDe(graph);
  const porId = new Map(graph.nodes.map((n) => [n.id, n]));
  const saidas: Record<string, unknown> = {};
  const passos: PassoSimulado[] = [];
  let atual: FlowNode | undefined = graph.nodes.find((n) => n.type === "trigger");
  const clock = () => new Date();

  while (atual && passos.length < TETO_DE_PASSOS) {
    const no: FlowNode = atual;
    const arestas: FlowEdge[] = saidasDoNo(no.id).filter((e) => branchOfSelectedEdge(e) !== ON_ERROR_BRANCH_ID);
    const base = { no_id: no.id, rotulo: no.label, tipo: no.type };
    const textos = textosDoBloco(no);
    const texto = textos.length ? textos.map((t) => previaDoTexto(t, graph, no.id, saidas).texto).join(" / ") : undefined;
    let proxima: FlowEdge | undefined;
    let ramo: string | null = null;

    if (no.type === "end") {
      passos.push({ ...base, previsto: `encerraria: ${resumoDoNo(no).resumo}`, ramo: null });
      break;
    }
    if (no.type === "condition") {
      let trace: { edge_id: string; branch_id: string } | undefined;
      processNode({
        node: no,
        edges: graph.edges,
        enrollment: { ...ENROLLMENT_DE_EXEMPLO, current_node_id: no.id },
        lead: fatos,
        clock,
        saidasAnteriores: saidas,
        onDecision: (v) => {
          trace = v;
        },
      });
      proxima = trace ? graph.edges.find((e) => e.id === trace!.edge_id) : arestas[0];
      ramo = trace?.branch_id ?? null;
    } else if (no.type === "ai_classify" || no.type === "match_reply") {
      const escolhido = entrada.escolhas?.[no.id];
      proxima = arestas.find((e) => branchOfSelectedEdge(e) === escolhido) ?? arestas[0];
      ramo = proxima ? branchOfSelectedEdge(proxima) : null;
    } else if (no.type === "map_data") {
      const r = mapearDados(no.config.fields, saidas);
      if (!r.ok) {
        passos.push({ ...base, previsto: "não conseguiria montar os campos", ramo: null, erro: r.motivo });
        break;
      }
      saidas[no.id] = { fields: r.fields };
      proxima = arestas[0];
    } else {
      proxima = arestas[0];
    }
    if (no.type !== "map_data") {
      const exemplo = saidaDeExemplo(no);
      if (exemplo) saidas[no.id] = exemplo;
    }
    passos.push({
      ...base,
      previsto: no.type === "trigger" ? "a execução começaria aqui" : `faria: ${resumoDoNo(no).resumo}`,
      ramo,
      ...(texto ? { texto } : {}),
    });
    atual = proxima ? porId.get(proxima.target) : undefined;
    if (!proxima) {
      passos.push({ ...base, previsto: "pararia aqui: não há saída ligada para este caminho", ramo, erro: "sem saída" });
      break;
    }
  }
  return passos;
}
