import type { ExecutionError } from "./execution-contract";
import type { EnrollmentRow, NodeResult, NodeDecisionTrace } from "./node-handlers";
import type { NodeOutput } from "./node-output-contracts";
import type { TimingPlan } from "./timing-plan";
import type { PedidoHttp } from "./requisicao-http";

/** Captação do `match_reply`: o texto que decidiu; o destino o diário tira do nó. */
export type ReplyCapture = { value: string };
import { z } from "zod";

export const executionDecisionInputSchema = z.object({
  /** `map_data`: as saídas dos blocos anteriores no instante da primeira tentativa (a nova tentativa usa as mesmas). */
  saidas: z.record(z.string(), z.json()).optional(),
  repeat: z
    .object({
      taken: z.number().int().nonnegative(),
      total: z.number().int().nonnegative().nullable(),
      reply: z.string().nullable(),
    })
    .optional(),
  facts: z.object({
    lead_stage: z.string().nullable(),
    tags: z.array(z.string()),
    steps_taken: z.number().int().nonnegative(),
    last_outcome: z.string().nullable(),
    products: z.array(z.string()).optional(),
    contact_name: z.string().nullable().optional(),
    custom_fields: z.record(z.string(), z.json()).optional(),
    contact_custom_fields: z.record(z.string(), z.json()).optional(),
  }),
});

/** Identidade interna; nunca aceita como configuração ou body de uma rota. */
export interface ExecutionAttemptHandle {
  organization_id: string;
  enrollment_id: string;
  step_id: string;
  attempt_id: string;
  node_id: string;
  visit: number;
  attempt_no: number;
  lease_revision: number;
}

export type BeginExecutionAttempt =
  | {
      kind: "ready";
      handle: ExecutionAttemptHandle;
      input: unknown;
      waiting_until?: string;
      /** A espera já venceu, medida no relógio do BANCO (o claim usa o mesmo). */
      waiting_elapsed?: boolean;
      /** `match_reply` de confirmação: a pergunta está na fila e ainda não saiu. */
      question_in_flight?: boolean;
    }
  | { kind: "reconcile" | "stopped"; step_id: string; attempt_id: string };

export interface ExecutionTaskResult {
  output: NodeOutput<"internal_task">;
  reused: boolean;
  notification?: {
    organization_id: string;
    task_id: string;
    title: string;
    assigned_to: string | null;
  };
}

export interface ExecutionJournal {
  begin(scope: EnrollmentRow, input: unknown, iteration?: number): Promise<BeginExecutionAttempt>;
  parkWait(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: Extract<NodeResult, { kind: "wait" }>,
  ): Promise<{ reused: boolean }>;
  /**
   * Associa a tentativa ao job real da fila (envio/IA). Idempotente para o mesmo job;
   * outro job na mesma tentativa é recusado — retry abre tentativa nova, nunca reaponta.
   */
  attachJob(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    jobId: string,
  ): Promise<{ reused: boolean }>;
  /**
   * Conclui o envio ligado ao job: o recibo vem do ledger de envio (mensagens ACEITAS pelo
   * canal), nunca do que o turno afirma. Sem recibo aceito não há sucesso. Grava efeito,
   * output, passagem e avanço (`action_sent`) na mesma transação; repetir devolve o recibo
   * (`output: null` se o payload já foi expurgado). O claim do job entra no evento, e o banco
   * recusa dentro da transação um worker que já perdeu o lease.
   */
  completeSend(
    scope: EnrollmentRow,
    jobId: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ output: NodeOutput<"action"> | null; reused: boolean }>;
  /** A pergunta de confirmação do `match_reply` saiu: registra o recibo e passa a esperar a resposta. */
  completeConfirmationSend(
    scope: EnrollmentRow,
    jobId: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }>;
  /** Conclusão da classificação por IA: o primeiro job vence, os reenfileirados voltam `reused`. */
  completeClassification(
    scope: EnrollmentRow,
    jobId: string,
    classification: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ output: NodeOutput<"ai_classify"> | null; reused: boolean }>;
  /**
   * O turno de planejamento do acionamento voltou: grava o plano de tempo das esperas adaptativas,
   * conclui a tentativa do gatilho e avança, na mesma transação. Repetir é no-op.
   */
  completePlan(
    scope: EnrollmentRow,
    jobId: string,
    plan: TimingPlan,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ output: NodeOutput<"trigger"> | null; reused: boolean }>;
  /** A carência venceu sem resposta: `no_reply` decidido pelo motor, sem chamar o modelo. */
  completeNoReply(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: { next_node_id: string },
  ): Promise<{ reused: boolean }>;
  /** Turno pulado (opt-out, conversa inelegível…): fecha tentativa e passagem como `skipped` e cancela. */
  completeSkipped(
    scope: EnrollmentRow,
    jobId: string,
    reason: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }>;
  /** Envio adiado pela janela: a tentativa segue aberta; só o adiamento é registrado. */
  deferSend(
    scope: EnrollmentRow,
    jobId: string,
    until: Date,
    returnAt: Date,
    reason: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }>;
  completeTask(scope: EnrollmentRow, handle: ExecutionAttemptHandle): Promise<ExecutionTaskResult>;
  completeTags(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"edit_lead_tag">; reused: boolean }>;
  /** Fase 5 — acrescenta (do catálogo) ou tira um produto do negócio, na transação do avanço. */
  completeProduct(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"lead_product">; reused: boolean }>;
  /**
   * Fase 5 — Requisição HTTP, passo 1 (antes da rede): grava a INTENÇÃO como efeito `pending` e devolve o pedido
   * congelado. Uma tentativa que morrer depois disto vira resultado incerto (Central), nunca reenvio automático.
   * `reused`: o passo já tinha recibo. `incerto`: a intenção já estava gravada sem desfecho.
   */
  prepareHttp(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<
    | { kind: "pedido"; pedido: PedidoHttp }
    | { kind: "reused"; output: NodeOutput<"http_request"> }
    | { kind: "incerto" }
  >;
  /** Passo 2: resposta 2xx — confirma o efeito, grava a saída e avança, na mesma transação. */
  completeHttp(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    output: NodeOutput<"http_request">,
  ): Promise<{ output: NodeOutput<"http_request">; reused: boolean }>;
  /** Passo 2 (falha): marca a intenção (`failed` = não saiu ou foi recusada; `unknown` = pode ter saído) e falha a tentativa. */
  failHttp(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    efeito: "failed" | "unknown",
    error: ExecutionError,
  ): Promise<void>;
  /** Fase 5 — acha (e, se pedido, cria) um contato pelo telefone ou e-mail, na transação do avanço. */
  completeContactLookup(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"find_or_create_contact">; reused: boolean }>;
  /** Fase 5 — acha (e, se pedido, cria) o negócio aberto do contato no funil, na transação do avanço. */
  completeLeadLookup(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"find_or_create_lead">; reused: boolean }>;
  /** Fase 5 — grava campo personalizado (do catálogo) ou valor do negócio, na transação do avanço. */
  completeField(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"update_lead_field">; reused: boolean }>;
  /** Fase 5 — nota interna no destino escolhido (negócio ou conversa), na transação do avanço. */
  completeNote(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"add_note">; reused: boolean }>;
  /** Fase 5 — troca o responsável do negócio, com a régua de membro ativo, na transação do avanço. */
  completeOwner(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"assign_lead_owner">; reused: boolean }>;
  completeMove(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<{ output: NodeOutput<"move_lead">; reused: boolean }>;
  fail(scope: EnrollmentRow, handle: ExecutionAttemptHandle, error: ExecutionError): Promise<void>;
  completeDecision(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: Extract<NodeResult, { kind: "advance" | "complete" }>,
    trace?: NodeDecisionTrace,
    /** `match_reply` com captação: a resposta a gravar no destino, na mesma transação do avanço. */
    capture?: ReplyCapture,
  ): Promise<{ reused: boolean }>;
}

export class ExecutionConfigurationError extends Error {
  readonly details?: ExecutionError["details"];
  constructor(
    readonly code: string,
    explanation?: string,
    details?: unknown,
  ) {
    super(explanation ?? code);
    this.details = details === undefined ? undefined : z.json().parse(details);
    this.name = "ExecutionConfigurationError";
  }
}
export { ExecutionConfigurationError as ExecutionTaskConfigurationError };

export class ExecutionInputChangedError extends Error {
  readonly code = "execution_input_changed";
  constructor() {
    super("execution_input_changed");
    this.name = "ExecutionInputChangedError";
  }
}
