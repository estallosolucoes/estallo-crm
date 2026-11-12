/**
 * O caminho de uma execução reconstruído a partir dos EVENTOS do motor (`followup_enrollment_events`).
 *
 * Existe porque o diário passo a passo (`followup_execution_steps`, contrato 1) ainda não está ligado em produção:
 * toda execução de hoje é de contrato 0 e só deixou eventos. Sem isto, o desenho de inspeção ficaria sem estado em
 * qualquer execução real. É uma reconstrução, e diz isso: não tem ENTRADA nem SAÍDA (o motor não as gravou), a
 * duração é a diferença entre o primeiro e o último evento do bloco, e o ramo só aparece quando o evento o carrega.
 * Quando o diário existir, `passos` do servidor tem prioridade e esta função não é chamada.
 */
import type { NoDoDossie } from "./eventos-legiveis";
import type { PassoDaExecucao } from "./passos-da-execucao";

export interface EventoParaCaminho {
  id: string;
  node_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const TERMINAIS = new Set(["completed", "cancelled", "dead"]);

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** O motivo do envio morto vem com um prefixo técnico (`action_turn_failed: …`); a tela mostra só a causa. */
function erroDoEvento(p: Record<string, unknown>): string | null {
  const bruto = texto(p.error) ?? texto(p.reason) ?? texto(p.code);
  if (!bruto) return null;
  const sem = bruto.startsWith("action_turn_failed:") ? bruto.slice("action_turn_failed:".length).trim() : bruto;
  return sem.slice(0, 300) || null;
}

export function passosDosEventos(
  eventos: EventoParaCaminho[],
  nos: ReadonlyMap<string, Pick<NoDoDossie, "rotulo" | "tipo">> | Record<string, Pick<NoDoDossie, "rotulo" | "tipo">>,
  contexto: { status: string; currentNodeId: string | null },
): PassoDaExecucao[] {
  const no = (id: string) => (nos instanceof Map ? nos.get(id) : (nos as Record<string, Pick<NoDoDossie, "rotulo" | "tipo">>)[id]);
  const ordenados = [...eventos].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
  );

  const passos: PassoDaExecucao[] = [];
  const abertos = new Map<string, PassoDaExecucao>();
  const visitas = new Map<string, number>();

  const abrir = (nodeId: string, quando: string): PassoDaExecucao => {
    const visit = visitas.get(nodeId) ?? 0;
    visitas.set(nodeId, visit + 1);
    const info = no(nodeId);
    const passo: PassoDaExecucao = {
      step_id: `ev:${nodeId}:${visit}`,
      node_id: nodeId,
      rotulo: info?.rotulo ?? nodeId,
      tipo: info?.tipo ?? null,
      status: "running",
      branch_id: null,
      visit,
      entered_at: quando,
      completed_at: null,
      duracao_ms: null,
      tentativas: 0,
      erro: null,
    };
    passos.push(passo);
    abertos.set(nodeId, passo);
    return passo;
  };
  const fechar = (passo: PassoDaExecucao, status: string, quando: string, erro: string | null = null) => {
    passo.status = status;
    passo.completed_at = quando;
    passo.duracao_ms = Math.max(0, Date.parse(quando) - Date.parse(passo.entered_at));
    if (erro) passo.erro = erro;
    abertos.delete(passo.node_id);
  };

  for (const e of ordenados) {
    if (!e.node_id) continue;
    const nodeId = e.node_id;
    const passo = abertos.get(nodeId) ?? abrir(nodeId, e.created_at);
    const p = e.payload ?? {};
    const proximo = texto(p.next_node_id);
    const seguir = () => {
      if (proximo && !abertos.has(proximo)) abrir(proximo, e.created_at);
    };

    switch (e.event_type) {
      case "turn_enqueued":
        passo.tentativas += 1;
        break;
      case "node_advanced":
        passo.branch_id = texto(p.class) ?? texto(p.branch_id) ?? passo.branch_id;
        fechar(passo, "succeeded", e.created_at);
        seguir();
        break;
      case "execution_error_routed":
        fechar(passo, "failed", e.created_at, erroDoEvento(p));
        seguir();
        break;
      case "node_failed":
      case "move_lead_failed":
      case "flow_dead":
        fechar(passo, "failed", e.created_at, erroDoEvento(p));
        break;
      case "flow_completed":
        fechar(passo, "succeeded", e.created_at);
        break;
      case "skipped_manual":
        fechar(passo, "skipped", e.created_at);
        seguir();
        break;
      default:
        break;
    }
  }

  // O que ficou aberto no fim: a execução terminada fecha o bloco pelo estado dela; a viva deixa "em andamento".
  if (TERMINAIS.has(contexto.status)) {
    for (const passo of abertos.values()) {
      const ultimo = ordenados.at(-1)?.created_at ?? passo.entered_at;
      if (contexto.status === "completed") fechar(passo, "succeeded", ultimo);
      else if (contexto.status === "dead") {
        fechar(passo, passo.node_id === contexto.currentNodeId ? "failed" : "succeeded", ultimo);
      } else fechar(passo, "skipped", ultimo);
    }
  }
  return passos;
}
