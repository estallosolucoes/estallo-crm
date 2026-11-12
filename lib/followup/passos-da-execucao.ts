/**
 * O CAMINHO PERCORRIDO por uma execução — o que o diário (`followup_execution_steps/attempts`) gravou, em ordem,
 * pronto para a tela. Execução de contrato 0 (anterior ao diário) não tem passos: a lista volta vazia e a tela cai
 * na linha do tempo de eventos, sem inventar dado.
 *
 * Duas regras de quem lê:
 *  - O que o nó FEZ (status, ramo, tentativas, erro curto) sai para qualquer membro: é o mesmo que a linha do tempo
 *    já mostra. A ENTRADA e a SAÍDA (`input_snapshot`/`output_snapshot`) só saem para quem edita o fluxo
 *    (`verDados`): o instantâneo pode carregar a configuração do nó, e a configuração tem o texto que o dono escreveu.
 *  - O erro vai como TEXTO curto, nunca como o objeto do banco.
 */
import type { NoDoDossie } from "./eventos-legiveis";

export interface PassoBruto {
  id: string;
  node_id: string;
  visit: number;
  status: string;
  branch_id: string | null;
  entered_at: string;
  completed_at: string | null;
}

export interface TentativaBruta {
  step_id: string;
  attempt_no: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  input_snapshot: unknown;
  output_snapshot: unknown;
  error_snapshot: unknown;
}

/** Uma tentativa de um nó — o que a pessoa escolhe para ver entrada, saída e erro daquela vez, e não só da última. */
export interface TentativaDoPasso {
  numero: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  erro: string | null;
  entrada?: unknown;
  saida?: unknown;
}

export interface PassoDaExecucao {
  step_id: string;
  node_id: string;
  rotulo: string;
  tipo: NoDoDossie["tipo"] | null;
  /** `succeeded`, `failed`, `skipped`, `running`… como o diário gravou. */
  status: string;
  /** Qual saída do nó foi tomada (`else`, o id da regra…). */
  branch_id: string | null;
  /** Quantas vezes o mesmo nó foi visitado antes (laço); 0 = primeira. */
  visit: number;
  entered_at: string;
  completed_at: string | null;
  duracao_ms: number | null;
  tentativas: number;
  erro: string | null;
  /** Cada tentativa, da primeira à última. Vazia em passo sem tentativa registrada (nó pulado, p.ex.). */
  tentativas_detalhe?: TentativaDoPasso[];
  entrada?: unknown;
  saida?: unknown;
}

const TETO_DO_TEXTO_DE_ERRO = 300;

/** Texto curto de um `error_snapshot`, seja qual for o formato que o diário gravou. */
export function erroEmTexto(snapshot: unknown): string | null {
  if (snapshot === null || snapshot === undefined) return null;
  if (typeof snapshot === "string") return snapshot.slice(0, TETO_DO_TEXTO_DE_ERRO) || null;
  if (typeof snapshot === "object") {
    const o = snapshot as Record<string, unknown>;
    const texto = [o.message, o.code, o.error].find((v) => typeof v === "string" && v.trim() !== "");
    if (typeof texto === "string") return texto.slice(0, TETO_DO_TEXTO_DE_ERRO);
    return null;
  }
  return null;
}

export function montarPassos(
  passos: PassoBruto[],
  tentativas: TentativaBruta[],
  nos: ReadonlyMap<string, Pick<NoDoDossie, "rotulo" | "tipo">>,
  verDados: boolean,
): PassoDaExecucao[] {
  const porPasso = new Map<string, TentativaBruta[]>();
  for (const t of tentativas) {
    const lista = porPasso.get(t.step_id);
    if (lista) lista.push(t);
    else porPasso.set(t.step_id, [t]);
  }
  return [...passos]
    .sort((a, b) => Date.parse(a.entered_at) - Date.parse(b.entered_at))
    .map((p) => {
      const lista = (porPasso.get(p.id) ?? []).sort((a, b) => a.attempt_no - b.attempt_no);
      const ultima = lista[lista.length - 1];
      const no = nos.get(p.node_id);
      const fim = p.completed_at ?? ultima?.completed_at ?? null;
      return {
        step_id: p.id,
        node_id: p.node_id,
        rotulo: no?.rotulo ?? p.node_id,
        tipo: no?.tipo ?? null,
        status: p.status,
        branch_id: p.branch_id,
        visit: p.visit,
        entered_at: p.entered_at,
        completed_at: fim,
        duracao_ms: fim ? Math.max(0, Date.parse(fim) - Date.parse(p.entered_at)) : null,
        tentativas: lista.length,
        erro: erroEmTexto(ultima?.error_snapshot),
        tentativas_detalhe: lista.map((t) => ({
          numero: t.attempt_no,
          status: t.status,
          started_at: t.started_at,
          completed_at: t.completed_at,
          erro: erroEmTexto(t.error_snapshot),
          // Como no passo: a entrada carrega a configuração do nó, então só sai para quem pode ver dados.
          ...(verDados ? { entrada: t.input_snapshot ?? null, saida: t.output_snapshot ?? null } : {}),
        })),
        ...(verDados && ultima
          ? { entrada: ultima.input_snapshot ?? null, saida: ultima.output_snapshot ?? null }
          : {}),
      };
    });
}
