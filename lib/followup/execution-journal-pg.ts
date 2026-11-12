import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { z } from "zod";

import { assertAgendaEffectPg } from "@/lib/agenda/efeito";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  requireCurrentServiceBoundary,
  guardServiceEffect,
} from "@/lib/atendimento/fronteira-server";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { aplicarTags } from "@/lib/leads/tags";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import type { AuditAction } from "@/lib/audit/actions";
import { prepararMovimentacaoDeLead } from "@/lib/leads/preparar-movimentacao";
import { recusaDeMotivoDaPerdaPeloBanco } from "@/lib/leads/motivo-da-perda";
import { stageChangeReason } from "@/lib/leads/activity-emitter";
import type { TimingPlan } from "./timing-plan";
import {
  interpolarDestino,
  persistirRespostaFollowupPg,
  recorteDaResposta,
} from "./persistir-resposta";
import { logger } from "@/lib/logger";
import { prepararAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import {
  prepararRegistroDaTarefa,
  type ContatoDoPedido,
  type LeadDoPedido,
} from "@/lib/tarefas/criar-tarefa";

import { effectIdentity, executionErrorSchema, type ExecutionError } from "./execution-contract";
import { ExecutionLeadUnavailableError } from "./execution-lead";
import {
  flowGraphSchema,
  NO_REPLY_BRANCH_ID,
  ON_ERROR_BRANCH_ID,
  type FlowNode,
} from "./graph-schema";
import {
  classEdgeMatch,
  selectEdge,
  branchOfSelectedEdge,
  BACKOFF_MS,
  type EnrollmentEventRef,
  type EnrollmentRow,
  type NodeResult,
  type NodeDecisionTrace,
} from "./node-handlers";
import { NODE_OUTPUT_CONTRACTS, type NodeOutput } from "./node-output-contracts";
import { MARCA_DE_BLOCO, resolverReferencias } from "./variaveis-de-blocos";
import { SQL_SAIDAS_DA_EXECUCAO } from "./sql-saidas-da-execucao";
import { centavosDoValor, converterValorDoCampo } from "./valor-do-campo";
import { corpoDaRequisicao, urlDaRequisicao, type PedidoHttp } from "./requisicao-http";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import {
  avisoDeRecuperacaoEsgotada,
  SQL_AVISO_RECUPERACAO_ESGOTADA,
} from "./no-show-recuperacao-esgotada";
import {
  ExecutionTaskConfigurationError,
  type ExecutionAttemptHandle,
  type BeginExecutionAttempt,
  type ExecutionJournal,
  type ExecutionTaskResult,
  type ReplyCapture,
  ExecutionInputChangedError,
} from "./execution-journal";
export { ExecutionTaskConfigurationError } from "./execution-journal";
export type { ExecutionAttemptHandle, BeginExecutionAttempt } from "./execution-journal";

const taskReadsSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  lead: z
    .object({
      id: z.uuid(),
      title: z.string().nullable().optional(),
      contact_id: z.uuid().nullable().optional(),
      owner_user_id: z.uuid().nullable().optional(),
    })
    .nullable(),
  contact: z
    .object({
      id: z.uuid(),
      name: z.string().nullable().optional(),
      display_name: z.string().nullable().optional(),
    })
    .nullable(),
  /** Saídas dos blocos anteriores, congeladas no `begin` quando o título cita `{{nodes.…}}`. */
  saidas: z.record(z.string(), z.json()).optional(),
});

/**
 * O título com as `{{nodes.<bloco>.<campo>}}` resolvidas pelas saídas congeladas. Variável sem valor NÃO vira título
 * cortado: a tarefa falha com a explicação (a mesma régua do envio de mensagem).
 */
function tituloComSaidas(titulo: string, saidas: Record<string, unknown> | undefined): string {
  if (!new RegExp(MARCA_DE_BLOCO.source).test(titulo)) return titulo;
  const r = resolverReferencias(titulo, saidas ?? {});
  if (r.sem_valor.length > 0)
    throw new ExecutionTaskConfigurationError(
      "variavel_sem_valor",
      `O título da tarefa cita ${[...new Set(r.sem_valor.map((x) => x.marca))].join(", ")}, mas o bloco citado não produziu esse valor nesta execução.`,
    );
  return r.texto;
}

function taskRequest(
  row: EnrollmentRow,
  node: Extract<FlowNode, { type: "internal_task" }>,
  saidas?: Record<string, unknown>,
) {
  return {
    organizationId: row.organization_id,
    titulo: tituloComSaidas(node.config.titulo, saidas),
    venceEmDias: node.config.vence_em_dias,
    atribuirA: node.config.atribuir_a,
    prioridade: node.config.prioridade,
    leadId: row.lead_id,
    contactId: row.contact_id,
    origem: `followup:${row.id}`,
  };
}

const contactLookupReadsSchema = z.object({
  busca: z.enum(["phone", "email"]),
  valor: z.string().nullable(),
  nome: z.string().nullable(),
  criar: z.boolean(),
  erro: z.string().nullable(),
});

const leadLookupReadsSchema = z.object({
  contact_id: z.string().nullable(),
  pipeline_id: z.string(),
  stage_id: z.string(),
  titulo: z.string().nullable(),
  criar: z.boolean(),
  erro: z.string().nullable(),
});

const httpReadsSchema = z.object({
  connection_id: z.string(),
  metodo: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().nullable(),
  corpo: z.json().nullable(),
  erro: z.string().nullable(),
});

const tagReadsSchema = z.object({
  lead_id: z.uuid().nullable(),
  previous_tags: z.array(z.string()),
  // Registros anteriores ao destino "contato" não têm a chave: valem como "card".
  destino: z.enum(["card", "contato"]).default("card"),
});

const fieldReadsSchema = z.object({
  alvo: z.enum(["custom_field", "deal_value", "contact_field"]),
  chave: z.string().nullable(),
  /** Valor já convertido pelo tipo do campo (ou centavos do valor do negócio); `null` quando falhou (ver `erro`). */
  valor: z.json().nullable(),
  erro: z.string().nullable(),
});

const noteReadsSchema = z.object({
  destino: z.enum(["lead_timeline", "conversation_notes"]),
  /** O texto com as variáveis já resolvidas; `null` quando faltou valor (o complete falha com `erro`). */
  texto: z.string().nullable(),
  erro: z.string().nullable(),
});

const ownerReadsSchema = z.object({
  lead_id: z.uuid(),
  previous_owner_user_id: z.uuid().nullable(),
  previous_owner_agent_id: z.uuid().nullable(),
});

const moveLeadReadSchema = z.looseObject({
  id: z.uuid(),
  pipeline_id: z.uuid().nullable(),
  stage_id: z.uuid().nullable(),
  updated_at: z.string(),
  status: z.string().nullable().optional(),
  lost_reason: z.string().nullable().optional(),
});
const moveStageReadSchema = z.object({
  id: z.uuid(),
  pipeline_id: z.uuid(),
  name: z.string().nullable(),
  is_won: z.boolean().nullable(),
  is_lost: z.boolean().nullable(),
});
const moveReadsSchema = z.object({
  lead: moveLeadReadSchema.nullable(),
  stage: moveStageReadSchema.nullable(),
  settings: z.json(),
  from_stage_name: z.string().nullable(),
});

type LockedExecution = EnrollmentRow & {
  pinned_graph: unknown;
  lease_until: string | null;
  lease_valid: boolean;
  origin_matches: boolean;
  organization_status: string;
  is_blocked: boolean;
  is_anonymized: boolean;
  is_personal: boolean;
  contact_kind: string;
};

/**
 * Persistência do motor existente. Cada transação usa UM PoolClient; nenhuma
 * chamada de IA, envio ou HTTP ocorre enquanto as travas estão abertas.
 * A capacidade pública continua desabilitada durante a integração dos nós.
 */
/** Piso da janela em que a tentativa de uma classificação pode ser reaproveitada (24 h). */
const CLASSIFY_REUSE_MIN_WINDOW_MS = 24 * 3600_000;
const CLASSIFY_REUSE_MAX_WINDOW_MS = 1e12;
/**
 * Quantas reentradas SEGUIDAS sem job novo ligado a mesma tentativa de um `ai_classify` aguenta
 * (o `attachJob` de um job novo zera o contador). Passado isso o `begin` segue o caminho de "lease
 * interrompido": fecha a tentativa e conta no orçamento de tentativas.
 */
const CLASSIFY_MAX_REUSES = 5;
/**
 * Teto ABSOLUTO de jobs ligados à mesma tentativa de um `ai_classify`. O zeramento do contador
 * acima confia que o job ligado conclui a tentativa; um job que derruba sempre o worker deixaria a
 * reentrada limitada só pelo relógio (um job novo a cada lease). Uma rajada real de respostas não
 * chega perto disto.
 */
const CLASSIFY_MAX_LINKED_JOBS = 50;

/**
 * Por quanto tempo o `begin` reaproveita a tentativa em voo de um `ai_classify` quando o lease
 * mudou: o maior entre 24 h e o DOBRO da carência do nó (uma carência longa não pode ser cortada
 * no meio). Os demais nós não reaproveitam (janela 0).
 */
function reuseWindowMs(node: FlowNode): number {
  if (node.type !== "ai_classify") return 0;
  // Teto de ~31 anos: o schema não limita a carência e `2 × 9e15 ms` estoura o `interval` do Postgres.
  return Math.min(
    CLASSIFY_REUSE_MAX_WINDOW_MS,
    Math.max(CLASSIFY_REUSE_MIN_WINDOW_MS, 2 * node.config.grace_timeout_ms),
  );
}

export class PgExecutionJournal implements ExecutionJournal {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // Erro de socket num cliente emprestado vira exceção não tratada e derruba o processo; a
    // query pendente já rejeita com o mesmo erro, então aqui só o registramos.
    let broken = false;
    const onClientError = (error: Error) => {
      broken = true;
      logger.warn("followup_execution_client_error", { message: error.message });
    };
    client.on("error", onClientError);
    try {
      await client.query("begin");
      await client.query("set local statement_timeout = '10s'");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.off("error", onClientError);
      // `release(true)` descarta o cliente: um socket que falhou não volta ao pool.
      client.release(broken);
    }
  }

  /**
   * "Agora" para agendar o próximo passo vem do relógio do BANCO: o claim compara com `now()` do
   * Postgres e o relógio do processo, que anda 17–34 ms à frente, faria a inscrição esperar o
   * tick seguinte (até 60 s). É `now()` direto, o mesmo valor de `fn_agora()` (migration 0147,
   * que existe para o PostgREST): numa conexão Postgres não depende de EXECUTE em função nenhuma,
   * então uma role de login dedicada (`agent_worker`, ver .env.example) também funciona. Um `Date`
   * do driver trunca em ms, então o valor nunca fica à frente do banco.
   */
  private async dbNow(client: pg.PoolClient): Promise<string> {
    const { rows } = await client.query<{ agora: Date }>("select now() as agora");
    return rows[0]!.agora.toISOString();
  }

  private async lockContact(client: pg.PoolClient, scope: EnrollmentRow): Promise<void> {
    const { rows } = await client.query<{ contact_id: string }>(
      "select contact_id from followup_enrollments where organization_id=$1 and id=$2",
      [scope.organization_id, scope.id],
    );
    if (rows[0]?.contact_id !== scope.contact_id) throw new StaleServiceBoundaryError();
    await client.query("select fn_service_lock($1,$2)", [scope.organization_id, scope.contact_id]);
  }

  private async current(
    client: pg.PoolClient,
    scope: EnrollmentRow,
  ): Promise<{ row: LockedExecution; node: FlowNode }> {
    const { rows } = await client.query<LockedExecution>(
      `select e.*, e.claimed_until::text as lease_until,
        (e.claimed_until is null or e.claimed_until > clock_timestamp()) as lease_valid,
        (e.service_boundary = $3::jsonb) as origin_matches,
        v.graph as pinned_graph, o.status as organization_status,
        c.is_blocked, c.is_anonymized, c.is_personal, c.kind as contact_kind
       from followup_enrollments e
       join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
       join organizations o on o.id=e.organization_id
       join contacts c on c.organization_id=e.organization_id and c.id=e.contact_id
       where e.organization_id=$1 and e.id=$2
       for update of e for share of o,c`,
      [scope.organization_id, scope.id, JSON.stringify(scope.service_boundary ?? null)],
    );
    const row = rows[0];
    if (
      !row ||
      scope.execution_contract !== 1 ||
      row.execution_contract !== 1 ||
      !Number.isSafeInteger(scope.revision) ||
      Number(row.revision) !== scope.revision ||
      row.current_node_id !== scope.current_node_id ||
      row.version_id !== scope.version_id ||
      row.lead_id !== (scope.lead_id ?? null) ||
      row.contact_id !== scope.contact_id ||
      !["active", "waiting_reply", "dormente"].includes(row.status) ||
      !row.lease_valid ||
      !row.origin_matches ||
      row.organization_status !== "active" ||
      row.is_blocked ||
      row.is_anonymized ||
      row.is_personal ||
      row.contact_kind === "whatsapp_group"
    ) {
      throw new StaleServiceBoundaryError();
    }
    await requireCurrentServiceBoundary(client, scope.service_boundary ?? null);
    await guardServiceEffect();
    if (row.status !== "dormente")
      await assertAgendaEffectPg(client, {
        organizationId: row.organization_id,
        contactId: row.contact_id,
        enrollmentId: row.id,
        nodeId: row.current_node_id,
      });
    const graph = flowGraphSchema.parse(row.pinned_graph);
    if (graph.execution_contract !== 1) throw new Error("execution_contract_mismatch");
    const node = graph.nodes.find((candidate) => candidate.id === row.current_node_id);
    if (!node) throw new Error("node_not_found");
    return { row, node };
  }

  /** `current` com «Aplicar em» resolvido — só nos blocos de efeito que o aceitam; o `fail` usa o `current` puro. */
  private async currentComAlvo(client: pg.PoolClient, scope: EnrollmentRow): Promise<{ row: LockedExecution; node: FlowNode }> {
    const { row, node } = await this.current(client, scope);
    return { row: await this.aplicarAlvo(client, row, node), node };
  }

  /**
   * «Aplicar em» (Fase 5): o bloco mira o negócio ou o contato que um Buscar ou criar ANTERIOR entregou, em vez do da
   * execução. O id vem das saídas congeladas desta execução e é conferido na organização — nunca do corpo de pedido.
   * Negócio → ele e o seu contato; contato → só o contato (blocos de negócio falham explicados). A conversa da execução
   * não é a do alvo: deixa de valer (nota na conversa falha explicada em vez de cair na conversa errada).
   */
  private async aplicarAlvo(client: pg.PoolClient, row: LockedExecution, node: FlowNode): Promise<LockedExecution> {
    const marca = "aplicar_em" in node.config && typeof node.config.aplicar_em === "string" ? node.config.aplicar_em.trim() : "";
    if (!marca) return row;
    const r = resolverReferencias(marca, await this.saidasDaExecucao(client, row));
    const id = r.texto.trim();
    if (r.sem_valor.length > 0 || !z.uuid().safeParse(id).success)
      throw new ExecutionTaskConfigurationError(
        "aplicar_em_sem_valor",
        `«Aplicar em» cita ${marca}, mas o bloco citado não entregou um negócio ou contato nesta execução.`,
      );
    const lead = (
      await client.query<{ id: string; contact_id: string | null }>(
        "select id,contact_id from crm_leads where organization_id=$1 and id=$2",
        [row.organization_id, id],
      )
    ).rows[0];
    if (lead && !lead.contact_id)
      throw new ExecutionTaskConfigurationError("aplicar_em_sem_contato", "O negócio de «Aplicar em» não tem contato vinculado.");
    const contactId = lead ? lead.contact_id! : id;
    const contato = (
      await client.query<{ is_anonymized: boolean; kind: string | null }>(
        "select is_anonymized,kind from contacts where organization_id=$1 and id=$2 and is_merged_into is null",
        [row.organization_id, contactId],
      )
    ).rows[0];
    if (!contato)
      throw new ExecutionTaskConfigurationError("aplicar_em_inexistente", "O negócio ou contato de «Aplicar em» não existe nesta organização.");
    if (contato.is_anonymized || contato.kind === "whatsapp_group")
      throw new ExecutionTaskConfigurationError("aplicar_em_indisponivel", "O contato de «Aplicar em» foi anonimizado ou é um grupo.");
    return { ...row, contact_id: contactId, lead_id: lead ? lead.id : null, conversation_id: null };
  }

  /** Buscar ou criar contato: o valor procurado e o nome, resolvidos e congelados. */
  private async contactLookupInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "find_or_create_contact" }>,
    requested: unknown,
  ) {
    const saidas = await this.saidasDaExecucao(client, row);
    const valor = resolverReferencias(node.config.valor, saidas);
    const nome = resolverReferencias(node.config.nome, saidas);
    return {
      requested,
      resolved: {
        busca: node.config.busca,
        valor: valor.sem_valor.length ? null : valor.texto.trim(),
        nome: nome.texto.trim() || null,
        criar: node.config.criar,
        erro: valor.sem_valor.length
          ? `A busca cita ${[...new Set(valor.sem_valor.map((x) => x.marca))].join(", ")}, mas o bloco citado não produziu esse valor nesta execução.`
          : null,
      },
    };
  }

  /** Buscar ou criar negócio: o contato (o da execução ou o de um bloco anterior) e o título, resolvidos e congelados. */
  private async leadLookupInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "find_or_create_lead" }>,
    requested: unknown,
  ) {
    const saidas = await this.saidasDaExecucao(client, row);
    const base = { pipeline_id: node.config.pipeline_id, stage_id: node.config.stage_id, criar: node.config.criar };
    let contactId: string | null = row.contact_id;
    let erro: string | null = null;
    if (node.config.contato.trim()) {
      const r = resolverReferencias(node.config.contato, saidas);
      contactId = z.uuid().safeParse(r.texto.trim()).success ? r.texto.trim() : null;
      if (!contactId) erro = `O contato cita ${node.config.contato.trim()}, mas o bloco citado não entregou um contato nesta execução.`;
    }
    const titulo = resolverReferencias(node.config.titulo, saidas).texto.trim();
    return { requested, resolved: { ...base, contact_id: contactId, titulo: titulo || null, erro } };
  }

  private async taskInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "internal_task" }>,
    requested: unknown,
  ) {
    const contact =
      (
        await client.query<ContatoDoPedido>(
          "select id,name,display_name from contacts where organization_id=$1 and id=$2",
          [row.organization_id, row.contact_id],
        )
      ).rows[0] ?? null;
    const lead = row.lead_id
      ? ((
          await client.query<LeadDoPedido>(
            "select id,title,contact_id,owner_user_id from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for share",
            [row.organization_id, row.contact_id, row.lead_id],
          )
        ).rows[0] ?? null)
      : null;
    if (row.lead_id && !lead) throw new ExecutionLeadUnavailableError();
    const at = new Date();
    const saidas = new RegExp(MARCA_DE_BLOCO.source).test(node.config.titulo)
      ? await this.saidasDaExecucao(client, row)
      : undefined;
    let prepared: ReturnType<typeof prepararRegistroDaTarefa> | null = null;
    try {
      prepared = prepararRegistroDaTarefa(taskRequest(row, node, saidas), { lead, contact }, at);
    } catch {
      // variável sem valor: o `completeTask` relança com a explicação, a partir das saídas congeladas aqui.
    }
    return {
      requested,
      resolved: {
        at: at.toISOString(),
        lead,
        contact,
        ...(saidas ? { saidas } : {}),
        task: prepared?.ok ? prepared.registro : null,
        preparation_error: prepared ? (prepared.ok ? null : prepared.codigo) : "variavel_sem_valor",
      },
    };
  }

  /** As saídas desta execução por bloco — a mesma régua de `loadStepOutputs` (passo concluído, última tentativa). */
  private async saidasDaExecucao(client: pg.PoolClient, row: LockedExecution): Promise<Record<string, unknown>> {
    const { rows } = await client.query<{ node_id: string; output_snapshot: unknown }>(SQL_SAIDAS_DA_EXECUCAO, [
      row.organization_id,
      row.id,
    ]);
    const saidas: Record<string, unknown> = {};
    for (const r of rows) if (r.output_snapshot !== null && r.output_snapshot !== undefined) saidas[r.node_id] = r.output_snapshot;
    return saidas;
  }

  /** O valor do campo resolvido e CONVERTIDO pelo tipo do catálogo, congelado: a nova tentativa grava o mesmo. */
  private async fieldInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "update_lead_field" }>,
    requested: unknown,
  ) {
    const cita = new RegExp(MARCA_DE_BLOCO.source).test(node.config.valor);
    const r = cita
      ? resolverReferencias(node.config.valor, await this.saidasDaExecucao(client, row))
      : { texto: node.config.valor, sem_valor: [] };
    const base = { alvo: node.config.alvo, chave: node.config.alvo === "deal_value" ? null : node.config.chave };
    if (r.sem_valor.length > 0)
      return {
        requested,
        resolved: {
          ...base,
          valor: null,
          erro: `O valor cita ${[...new Set(r.sem_valor.map((x) => x.marca))].join(", ")}, mas o bloco citado não produziu esse valor nesta execução.`,
        },
      };
    if (node.config.alvo === "deal_value") {
      const centavos = centavosDoValor(r.texto);
      return {
        requested,
        resolved: { ...base, valor: centavos, erro: centavos === null ? `«${r.texto}» não é um valor em reais.` : null },
      };
    }
    const def = (
      await client.query<{ key: string; label: string; type: string; options: Array<{ value: string; label: string }> }>(
        "select key,label,type,options from custom_field_definitions where organization_id=$1 and entity=$3 and key=$2",
        [row.organization_id, node.config.chave, node.config.alvo === "contact_field" ? "contact" : "lead"],
      )
    ).rows[0];
    if (!def)
      return {
        requested,
        resolved: {
          ...base,
          valor: null,
          erro: `O campo «${node.config.chave}» não existe mais no cadastro de campos do ${node.config.alvo === "contact_field" ? "contato" : "negócio"}.`,
        },
      };
    const c = converterValorDoCampo(def as Parameters<typeof converterValorDoCampo>[0], r.texto);
    return { requested, resolved: { ...base, valor: c.ok ? c.valor : null, erro: c.ok ? null : c.motivo } };
  }

  /**
   * A requisição HTTP resolvida e CONGELADA: URL (caminho contra a origem da conexão) e corpo com as saídas anteriores.
   * A nova tentativa manda exatamente o mesmo pedido. A credencial NÃO entra aqui: é lida no `prepareHttp`.
   */
  private async httpInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "http_request" }>,
    requested: unknown,
  ) {
    const base = { connection_id: node.config.connection_id, metodo: node.config.metodo };
    const conexao = node.config.connection_id
      ? (
          await client.query<{ base_url: string }>(
            "select base_url from automation_http_connections where organization_id=$1 and id=$2",
            [row.organization_id, node.config.connection_id],
          )
        ).rows[0]
      : undefined;
    if (!conexao)
      return { requested, resolved: { ...base, url: null, corpo: null, erro: "A conexão escolhida não existe mais nesta organização." } };
    const saidas = await this.saidasDaExecucao(client, row);
    const alvo = urlDaRequisicao(conexao.base_url, node.config.caminho, saidas);
    const corpo = corpoDaRequisicao(node.config.corpo, saidas);
    const semValor = [...alvo.sem_valor, ...(corpo.ok ? corpo.sem_valor : [])];
    const erro =
      semValor.length > 0
        ? `A requisição cita ${[...new Set(semValor.map((x) => x.marca))].join(", ")}, mas o bloco citado não produziu esse valor nesta execução.`
        : !corpo.ok
          ? corpo.motivo
          : alvo.url === null
            ? "O caminho precisa começar com / e não pode sair do endereço da conexão."
            : null;
    return {
      requested,
      resolved: { ...base, url: erro ? null : alvo.url, corpo: erro || !corpo.ok ? null : (corpo.corpo ?? null), erro },
    };
  }

  /** O texto da nota com as saídas anteriores resolvidas, congelado: a nova tentativa grava o MESMO texto. */
  private async noteInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "add_note" }>,
    requested: unknown,
  ) {
    const cita = new RegExp(MARCA_DE_BLOCO.source).test(node.config.texto);
    const r = cita
      ? resolverReferencias(node.config.texto, await this.saidasDaExecucao(client, row))
      : { texto: node.config.texto, sem_valor: [] };
    const erro =
      r.sem_valor.length > 0
        ? `A nota cita ${[...new Set(r.sem_valor.map((x) => x.marca))].join(", ")}, mas o bloco citado não produziu esse valor nesta execução.`
        : null;
    return {
      requested,
      resolved: { destino: node.config.destino, texto: erro ? null : r.texto.trim(), erro },
    };
  }

  /** O dono do negócio ANTES do bloco — o `completeOwner` recusa se outra pessoa o trocou no meio. */
  private async ownerInput(client: pg.PoolClient, row: LockedExecution, requested: unknown) {
    if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
    const lead = (
      await client.query<{ id: string; owner_user_id: string | null; owner_agent_id: string | null }>(
        "select id,owner_user_id,owner_agent_id from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for share",
        [row.organization_id, row.contact_id, row.lead_id],
      )
    ).rows[0];
    if (!lead) throw new ExecutionLeadUnavailableError();
    return {
      requested,
      resolved: {
        lead_id: lead.id,
        previous_owner_user_id: lead.owner_user_id,
        previous_owner_agent_id: lead.owner_agent_id,
      },
    };
  }

  private async tagInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "edit_lead_tag" }>,
    requested: unknown,
  ) {
    if (node.config.destino === "contato") {
      const contact = (
        await client.query<{ tags: string[] | null }>(
          "select tags from contacts where organization_id=$1 and id=$2 for share",
          [row.organization_id, row.contact_id],
        )
      ).rows[0];
      if (!contact) throw new ExecutionLeadUnavailableError();
      return {
        requested,
        resolved: { lead_id: row.lead_id, previous_tags: contact.tags ?? [], destino: "contato" },
      };
    }
    const lead = row.lead_id
      ? (
          await client.query<{ id: string; tags: string[] | null }>(
            "select id,tags from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for share",
            [row.organization_id, row.contact_id, row.lead_id],
          )
        ).rows[0]
      : null;
    if (row.lead_id && !lead) throw new ExecutionLeadUnavailableError();
    return {
      requested,
      resolved: { lead_id: lead?.id ?? null, previous_tags: lead?.tags ?? [], destino: "card" },
    };
  }

  private async moveInput(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "move_lead" }>,
    requested: unknown,
  ) {
    const lead = row.lead_id
      ? (
          await client.query<{ lead: unknown }>(
            "select to_jsonb(l) as lead from crm_leads l where l.organization_id=$1 and l.contact_id=$2 and l.id=$3 for share",
            [row.organization_id, row.contact_id, row.lead_id],
          )
        ).rows[0]?.lead
      : null;
    const parsedLead = lead ? moveLeadReadSchema.parse(lead) : null;
    if (row.lead_id && !parsedLead) throw new ExecutionLeadUnavailableError();
    const stage = z.uuid().safeParse(node.config.stage_id).success
      ? ((
          await client.query(
            "select id,pipeline_id,name,is_won,is_lost from crm_stages where organization_id=$1 and id=$2 for share",
            [row.organization_id, node.config.stage_id],
          )
        ).rows[0] ?? null)
      : null;
    // As regras (campos obrigatórios, reabertura) são as do funil de DESTINO — igual ao do negócio quando não troca.
    const pipelineDasRegras = (stage?.pipeline_id as string | undefined) ?? parsedLead?.pipeline_id ?? null;
    const pipeline = pipelineDasRegras
      ? (
          await client.query<{ settings: unknown }>(
            "select settings from crm_pipelines where organization_id=$1 and id=$2 for share",
            [row.organization_id, pipelineDasRegras],
          )
        ).rows[0]
      : null;
    const source = parsedLead?.stage_id
      ? (
          await client.query<{ name: string }>(
            "select name from crm_stages where organization_id=$1 and id=$2 for share",
            [row.organization_id, parsedLead.stage_id],
          )
        ).rows[0]
      : null;
    return {
      requested,
      resolved: {
        lead: parsedLead,
        stage,
        settings: pipeline?.settings ?? null,
        from_stage_name: source?.name ?? null,
      },
    };
  }

  private localEffectKey(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    operation: string,
  ): string {
    return effectIdentity({
      organization_id: scope.organization_id,
      root_execution_id: scope.id,
      node_id: handle.node_id,
      visit: handle.visit,
      item_key: null,
      operation,
    });
  }

  private async confirmedEffect<T>(
    client: pg.PoolClient,
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    operation: string,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    const { rows } = await client.query<{ result_snapshot: unknown; payload_expired_at: unknown }>(
      `select f.result_snapshot,f.payload_expired_at from followup_execution_effects f
       join followup_execution_attempts a on a.organization_id=f.organization_id and a.step_id=f.step_id
       where f.organization_id=$1 and f.enrollment_id=$2 and f.step_id=$3 and f.effect_key=$4
         and f.operation=$5 and f.status='confirmed' and a.id=$6`,
      [
        scope.organization_id,
        scope.id,
        handle.step_id,
        this.localEffectKey(scope, handle, operation),
        operation,
        handle.attempt_id,
      ],
    );
    if (!rows[0]) return undefined;
    if (rows[0].payload_expired_at)
      throw new ExecutionTaskConfigurationError("execution_payload_expired");
    return schema.parse(rows[0].result_snapshot);
  }

  private async confirmLocalEffect(
    client: pg.PoolClient,
    row: LockedExecution,
    handle: ExecutionAttemptHandle,
    operation: string,
    output: unknown,
    /** O efeito já existe como intenção `pending` (efeito externo, como a Requisição HTTP): confirma a MESMA linha. */
    intencaoGravada = false,
  ): Promise<void> {
    if (intencaoGravada) {
      const confirmado = await client.query(
        `update followup_execution_effects set status='confirmed',result_snapshot=$4,updated_at=clock_timestamp()
         where organization_id=$1 and step_id=$2 and effect_key=$3 and status='pending'`,
        [row.organization_id, handle.step_id, this.localEffectKey(row, handle, operation), output],
      );
      if (confirmado.rowCount !== 1) throw new StaleServiceBoundaryError();
    } else
      await client.query(
        `insert into followup_execution_effects
        (organization_id,enrollment_id,step_id,effect_key,operation,status,result_snapshot)
        values($1,$2,$3,$4,$5,'confirmed',$6)`,
        [
          row.organization_id,
          row.id,
          handle.step_id,
          this.localEffectKey(row, handle, operation),
          operation,
          output,
        ],
      );
    await client.query(
      `update followup_execution_attempts set status='succeeded',completed_at=clock_timestamp(),
      output_snapshot=$3,output_recorded=true where organization_id=$1 and id=$2`,
      [row.organization_id, handle.attempt_id, output],
    );
    const graph = flowGraphSchema.parse(row.pinned_graph);
    const edge = selectEdge(graph.edges, row.current_node_id, { type: "always" });
    if (!edge) throw new ExecutionTaskConfigurationError("execution_outbound_edge_missing");
    await client.query(
      "update followup_execution_steps set status='succeeded',branch_id=$3,completed_at=clock_timestamp() where organization_id=$1 and id=$2",
      [row.organization_id, handle.step_id, branchOfSelectedEdge(edge)],
    );
    await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      row.organization_id,
      row.id,
      Number(row.revision),
      {
        current_node_id: edge.target,
        status: "active",
        next_eval_at: await this.dbNow(client),
        steps_taken: row.steps_taken + 1,
        claimed_until: null,
        attempts: 0,
        last_error: null,
      },
      {
        node_id: row.current_node_id,
        event_type: "node_advanced",
        payload: {
          next_node_id: edge.target,
          edge_id: edge.id,
          branch_id: branchOfSelectedEdge(edge),
          step_id: handle.step_id,
          attempt_id: handle.attempt_id,
        },
        idempotency_key: `${row.current_node_id}:${row.steps_taken}`,
      },
    ]);
  }

  private assertHandle(scope: EnrollmentRow, handle: ExecutionAttemptHandle): void {
    if (
      scope.organization_id !== handle.organization_id ||
      scope.id !== handle.enrollment_id ||
      scope.current_node_id !== handle.node_id ||
      scope.revision !== handle.lease_revision
    )
      throw new StaleServiceBoundaryError();
  }

  private async holdAttempt(
    client: pg.PoolClient,
    row: LockedExecution,
    handle: ExecutionAttemptHandle,
    allowWaiting = false,
  ) {
    const { rows } = await client.query<{
      id: string;
      input_snapshot: unknown;
      next_eval_at: string | null;
    }>(
      `select a.id,a.input_snapshot,a.next_eval_at::text from followup_execution_attempts a
       join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
       where a.organization_id=$1 and a.id=$2 and a.step_id=$3 and (a.status='running' or ($8 and a.status='waiting'))
         and a.lease_revision=$4 and s.enrollment_id=$5 and s.node_id=$6 and s.visit=$7 and (s.status='running' or ($8 and s.status='waiting'))
         and a.payload_expired_at is null for update of a,s`,
      [
        row.organization_id,
        handle.attempt_id,
        handle.step_id,
        handle.lease_revision,
        row.id,
        row.current_node_id,
        handle.visit,
        allowWaiting,
      ],
    );
    if (!rows[0]) throw new StaleServiceBoundaryError();
    return rows[0];
  }

  async begin(scope: EnrollmentRow, input: unknown, iteration = 0): Promise<BeginExecutionAttempt> {
    const parsedInput = z.json().safeParse(input);
    if (!parsedInput.success) throw new ExecutionTaskConfigurationError("execution_input_invalid");
    const snapshot = parsedInput.data;
    if (!Number.isSafeInteger(iteration) || iteration < 0)
      throw new Error("invalid_execution_iteration");
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const { row, node } = await this.current(client, scope);
      const org = scope.organization_id;
      const { rows: open } = await client.query<{ id: string; visit: number; status: string }>(
        `select id,visit,status from followup_execution_steps
         where organization_id=$1 and enrollment_id=$2 and node_id=$3
           and status in ('pending','running','waiting') order by visit desc`,
        [org, scope.id, node.id],
      );
      if (open.length > 1) throw new Error("execution_multiple_open_steps");
      let step = open[0];
      if (!step) {
        const { rows } = await client.query<{ id: string; visit: number; status: string }>(
          `insert into followup_execution_steps (organization_id,enrollment_id,node_id,visit,iteration,status)
           select $1,$2,$3,coalesce(max(visit),-1)+1,$4,'running' from followup_execution_steps
           where organization_id=$1 and enrollment_id=$2 and node_id=$3 returning id,visit,status`,
          [org, scope.id, node.id, iteration],
        );
        step = rows[0]!;
      }
      if (step.status === "pending")
        await client.query(
          "update followup_execution_steps set status='running' where organization_id=$1 and id=$2",
          [org, step.id],
        );
      const { rows: previous } = await client.query<{
        id: string;
        attempt_no: number;
        status: string;
        current_lease: boolean;
        input_snapshot: unknown;
        next_eval_at: string | null;
        elapsed: boolean;
        reusable: boolean;
        job_alive: boolean;
        reuse_count: number;
        linked_jobs: number;
      }>(
        `select id,attempt_no,status,input_snapshot,next_eval_at,reuse_count,
          (select count(*)::int from followup_execution_attempt_jobs j
            where j.organization_id=$1 and j.attempt_id=followup_execution_attempts.id) as linked_jobs,
          (next_eval_at is not null and next_eval_at <= now()) as elapsed,
          (started_at > now() - ($5::double precision * interval '1 millisecond')) as reusable,
          exists (select 1 from followup_execution_attempt_jobs j
            join job_queue q on q.organization_id=j.organization_id and q.id=j.job_id
            where j.organization_id=$1 and j.attempt_id=followup_execution_attempts.id
              and q.status in ('pending','running')) as job_alive,
          (lease_revision=$3 and lease_until is not distinct from $4::timestamptz) as current_lease
         from followup_execution_attempts where organization_id=$1 and step_id=$2
         order by attempt_no desc limit 1 for update`,
        [org, step.id, Number(row.revision), row.lease_until, reuseWindowMs(node)],
      );
      const prior = previous[0];
      const handle = (attemptId: string, attemptNo: number): ExecutionAttemptHandle => ({
        organization_id: org,
        enrollment_id: scope.id,
        step_id: step.id,
        attempt_id: attemptId,
        node_id: node.id,
        visit: step.visit,
        attempt_no: attemptNo,
        lease_revision: Number(row.revision),
      });
      if (step.status === "waiting") {
        if (
          (node.type !== "wait" && node.type !== "match_reply") ||
          prior?.status !== "waiting" ||
          !prior.next_eval_at
        )
          throw new Error("execution_wait_state_invalid");
        await client.query(
          "update followup_execution_attempts set lease_revision=$3,lease_until=$4::timestamptz where organization_id=$1 and id=$2",
          [org, prior.id, Number(row.revision), row.lease_until],
        );
        return {
          kind: "ready",
          handle: handle(prior.id, prior.attempt_no),
          input: prior.input_snapshot,
          waiting_until: new Date(prior.next_eval_at).toISOString(),
          waiting_elapsed: prior.elapsed,
        };
      }
      // Reenfileirar a classificação (resposta que acorda o nó cedo) NÃO fecha a tentativa em voo:
      // o job anterior segue na fila e precisa poder concluí-la. A tentativa muda de lease e ganha
      // outro job (`attachJob`); o primeiro a concluir vence e os demais viram no-op.
      // Só dentro da janela e até CLASSIFY_MAX_REUSES vezes: reaproveitar sem limite pularia o orçamento
      // de tentativas dos demais nós, e um worker que morre sempre no mesmo ponto reentraria por toda a
      // janela sem aviso. Passado qualquer dos dois, cai no caminho de "lease interrompido" abaixo, que
      // conta e termina em aviso na Central.
      if (
        prior?.status === "running" &&
        !prior.current_lease &&
        node.type === "ai_classify" &&
        prior.reusable &&
        prior.reuse_count < CLASSIFY_MAX_REUSES &&
        prior.linked_jobs < CLASSIFY_MAX_LINKED_JOBS
      ) {
        await client.query(
          "update followup_execution_attempts set lease_revision=$3,lease_until=$4::timestamptz,reuse_count=reuse_count+1 where organization_id=$1 and id=$2",
          [org, prior.id, Number(row.revision), row.lease_until],
        );
        return {
          kind: "ready",
          handle: handle(prior.id, prior.attempt_no),
          input: prior.input_snapshot,
        };
      }
      // `match_reply` de confirmação: a pergunta já está na fila (job ligado) e ainda não saiu. Quem
      // acorda agora (resposta do lead, carência) não decide nada nem abre tentativa nova — abrir
      // outra enfileiraria a pergunta de novo. Só dentro da janela; passada, cai em "interrompido".
      if (
        prior?.status === "running" &&
        !prior.current_lease &&
        node.type === "match_reply" &&
        // A pergunta pode ficar horas na fila (janela de disparo, fim de semana): enquanto o job
        // ligado estiver vivo, a tentativa é dele. Job terminal sem recibo NÃO a segura: cai em
        // "interrompido" e, esgotadas as tentativas, abre aviso na Central.
        prior.job_alive
      ) {
        await client.query(
          "update followup_execution_attempts set lease_revision=$3,lease_until=$4::timestamptz where organization_id=$1 and id=$2",
          [org, prior.id, Number(row.revision), row.lease_until],
        );
        return {
          kind: "ready",
          handle: handle(prior.id, prior.attempt_no),
          input: prior.input_snapshot,
          question_in_flight: true,
        };
      }
      if (prior?.status === "running" && prior.current_lease) {
        return {
          kind: "ready",
          handle: handle(prior.id, prior.attempt_no),
          input: prior.input_snapshot,
          ...(node.type === "match_reply" && prior.job_alive
            ? { question_in_flight: true }
            : {}),
          ...(prior.next_eval_at
            ? {
                waiting_until: new Date(prior.next_eval_at).toISOString(),
                waiting_elapsed: prior.elapsed,
              }
            : {}),
        };
      }
      if (prior?.status === "running") {
        const { rows: effects } = await client.query(
          "select id from followup_execution_effects where organization_id=$1 and step_id=$2 and status<>'failed' limit 1",
          [org, step.id],
        );
        const unknown = effects.length > 0;
        const error = {
          code: "execution_lease_interrupted",
          message: "O processamento anterior foi interrompido.",
          category: unknown ? "unknown" : "transient",
          retryable: !unknown,
        };
        await client.query(
          `update followup_execution_attempts set status=$3,completed_at=clock_timestamp(),error_snapshot=$4
           where organization_id=$1 and id=$2`,
          [org, prior.id, unknown ? "unknown" : "failed", error],
        );
        if (unknown) {
          await client.query(
            "update followup_execution_steps set status='unknown',completed_at=clock_timestamp() where organization_id=$1 and id=$2",
            [org, step.id],
          );
          await client.query(
            "update followup_execution_effects set status='unknown',updated_at=clock_timestamp() where organization_id=$1 and step_id=$2 and status='pending'",
            [org, step.id],
          );
          await this.stop(client, row, step.id, prior.id, error.code, "execution_unknown");
          return { kind: "reconcile", step_id: step.id, attempt_id: prior.id };
        }
      }
      if (prior && prior.attempt_no >= row.max_attempts + 1) {
        await client.query(
          "update followup_execution_steps set status='failed',completed_at=clock_timestamp() where organization_id=$1 and id=$2",
          [org, step.id],
        );
        if (
          await this.routeToErrorEdge(client, row, step.id, prior.id, "execution_attempt_budget_exhausted")
        )
          return { kind: "stopped", step_id: step.id, attempt_id: prior.id };
        await this.stop(
          client,
          row,
          step.id,
          prior.id,
          "execution_attempt_budget_exhausted",
          "execution_failed",
        );
        return { kind: "stopped", step_id: step.id, attempt_id: prior.id };
      }
      const attemptNo = (prior?.attempt_no ?? 0) + 1;
      // «Aplicar em» vale para as leituras congeladas. Alvo inválido congela leitura vazia: o complete* relê o alvo e falha explicado.
      let alvoRow: LockedExecution | null = row;
      try {
        alvoRow = await this.aplicarAlvo(client, row, node);
      } catch (e) {
        if (!(e instanceof ExecutionTaskConfigurationError)) throw e;
        alvoRow = null;
      }
      const resolvedInput =
        alvoRow === null
          ? { requested: snapshot, resolved: null }
          : node.type === "wait" && prior?.next_eval_at
          ? prior.input_snapshot
          : node.type === "internal_task"
            ? await this.taskInput(client, alvoRow, node, snapshot)
            : node.type === "edit_lead_tag"
              ? await this.tagInput(client, alvoRow, node, snapshot)
              : node.type === "move_lead"
                ? await this.moveInput(client, alvoRow, node, snapshot)
                : node.type === "assign_lead_owner"
                  ? await this.ownerInput(client, alvoRow, snapshot)
                  : node.type === "add_note"
                    ? await this.noteInput(client, alvoRow, node, snapshot)
                    : node.type === "update_lead_field"
                      ? await this.fieldInput(client, alvoRow, node, snapshot)
                      : node.type === "http_request"
                        ? await this.httpInput(client, alvoRow, node, snapshot)
                        : node.type === "find_or_create_contact"
                          ? await this.contactLookupInput(client, alvoRow, node, snapshot)
                          : node.type === "find_or_create_lead"
                            ? await this.leadLookupInput(client, alvoRow, node, snapshot)
                            : snapshot;
      const { rows } = await client.query<{ id: string }>(
        `insert into followup_execution_attempts
          (organization_id,step_id,attempt_no,status,input_snapshot,config_snapshot,lease_revision,lease_until,next_eval_at)
         values ($1,$2,$3,'running',$4,$5,$6,$7::timestamptz,$8::timestamptz) returning id`,
        [
          org,
          step.id,
          attemptNo,
          resolvedInput,
          node.config,
          Number(row.revision),
          row.lease_until,
          node.type === "wait" ? (prior?.next_eval_at ?? null) : null,
        ],
      );
      return {
        kind: "ready",
        handle: handle(rows[0]!.id, attemptNo),
        input: resolvedInput,
        ...(node.type === "wait" && prior?.next_eval_at
          ? {
              waiting_until: new Date(prior.next_eval_at).toISOString(),
              waiting_elapsed: prior.elapsed,
            }
          : {}),
      };
    });
  }

  /** Repetir após perda do ACK devolve o recibo; não recria a tarefa nem avança novamente. */
  async completeTask(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
  ): Promise<ExecutionTaskResult> {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(
        client,
        scope,
        handle,
        "create_task",
        NODE_OUTPUT_CONTRACTS.internal_task,
      );
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "internal_task") throw new Error("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: taskReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.contact?.id !== row.contact_id || (reads.lead?.id ?? null) !== row.lead_id)
        throw new ExecutionLeadUnavailableError();
      const prepared = prepararRegistroDaTarefa(
        taskRequest(row, node, reads.saidas),
        { lead: reads.lead, contact: reads.contact },
        new Date(reads.at),
      );
      if (!prepared.ok)
        throw new ExecutionTaskConfigurationError(
          prepared.codigo,
          prepared.codigo === "sem_dono"
            ? "O Lead não tem responsável para receber a tarefa."
            : prepared.codigo === "titulo_vazio"
              ? "O título da tarefa ficou vazio após resolver as variáveis."
              : "Não há Lead ou contato para a tarefa.",
        );
      const task = prepared.registro;
      const { rows: members } = await client.query(
        "select user_id from user_organizations where organization_id=$1 and user_id=$2 and accepted_at is not null",
        [row.organization_id, task.assigned_to],
      );
      if (!members[0]) throw new ExecutionTaskConfigurationError("task_assignee_unavailable");
      const taskId = randomUUID();
      await client.query(
        `insert into crm_tasks (id,organization_id,title,description,due_date,priority,status,lead_id,contact_id,assigned_to,created_by)
         values ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,null)`,
        [
          taskId,
          task.organization_id,
          task.title,
          task.description,
          task.due_date,
          task.priority,
          task.lead_id,
          task.contact_id,
          task.assigned_to,
        ],
      );
      const activity = prepararAtividadeDaTarefa({
        organizationId: row.organization_id,
        tarefa: { id: taskId, ...task },
        tipo: "task_created",
        actor: { type: "webhook_source", id: `followup:${row.id}` },
      });
      if (activity) {
        const a = buildLeadActivityRow(activity);
        await client.query(
          `insert into crm_lead_activities
           (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,actor_agent_id,performed_by_user_id,reason,evidence,payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            a.organization_id,
            a.lead_id,
            a.contact_id,
            a.type,
            a.source_module,
            a.source_id,
            a.actor_kind,
            a.actor_agent_id,
            a.performed_by_user_id,
            a.reason,
            a.evidence,
            a.payload,
          ],
        );
      }
      const output = NODE_OUTPUT_CONTRACTS.internal_task.parse({
        task_id: taskId,
        contact_id: row.contact_id,
        lead_id: row.lead_id,
      });
      await this.confirmLocalEffect(client, row, handle, "create_task", output);
      // Auditoria continua best effort. Um SAVEPOINT impede que falha no log desfaça a tarefa.
      await client.query("savepoint execution_task_audit");
      try {
        await client.query(
          `insert into api_audit_log (organization_id,action,resource_type,resource_id,bypassed_rls,metadata)
           values ($1,'crm_task.created','crm_task',$2,true,$3)`,
          [
            row.organization_id,
            taskId,
            {
              origem: `followup:${row.id}`,
              lead_id: row.lead_id,
              contact_id: row.contact_id,
              assigned_to: task.assigned_to,
              prioridade: task.priority,
              vence_em_dias: node.config.vence_em_dias,
              execution_step_id: handle.step_id,
              execution_attempt_id: handle.attempt_id,
            },
          ],
        );
        await client.query("release savepoint execution_task_audit");
      } catch {
        await client.query("rollback to savepoint execution_task_audit");
        logger.warn("followup_execution_task_audit_failed", {
          organization_id: row.organization_id,
          task_id: taskId,
        });
      }
      return {
        output,
        reused: false,
        notification: {
          organization_id: row.organization_id,
          task_id: taskId,
          title: task.title,
          assigned_to: task.assigned_to,
        },
      };
    });
  }

  private async auditEffect(
    client: pg.PoolClient,
    org: string,
    action: AuditAction,
    resourceType: string,
    rowId: string, // uuid da linha afetada (crm_lead): nunca chave natural
    metadata: Record<string, unknown>,
  ) {
    await client.query("savepoint execution_effect_audit");
    try {
      await client.query(
        `insert into api_audit_log (organization_id,action,resource_type,resource_id,bypassed_rls,metadata)
        values($1,$2,$3,$4,true,$5)`,
        [org, action, resourceType, rowId, metadata],
      );
      await client.query("release savepoint execution_effect_audit");
    } catch {
      await client.query("rollback to savepoint execution_effect_audit");
      logger.warn("followup_execution_effect_audit_failed", {
        organization_id: org,
        action,
        resource_id: rowId,
      });
    }
  }

  async completeTags(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(
        client,
        scope,
        handle,
        "add_tag",
        NODE_OUTPUT_CONTRACTS.edit_lead_tag,
      );
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "edit_lead_tag")
        throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      if (node.config.destino === "contato") return this.completeContactTags(client, row, node, handle, held);
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      if (!node.config.tags.length) throw new ExecutionTaskConfigurationError("tag_ausente");
      const reads = z.object({ resolved: tagReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.lead_id !== row.lead_id) throw new ExecutionLeadUnavailableError();
      const lead = (
        await client.query<{ id: string; tags: string[] | null }>(
          "select id,tags from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for update",
          [row.organization_id, row.contact_id, row.lead_id],
        )
      ).rows[0];
      if (!lead) throw new ExecutionLeadUnavailableError();
      if (JSON.stringify(lead.tags ?? []) !== JSON.stringify(reads.previous_tags))
        throw new ExecutionInputChangedError();
      const merged = aplicarTags(reads.previous_tags, node.config.tags, node.config.acao);
      const output = NODE_OUTPUT_CONTRACTS.edit_lead_tag.parse({
        lead_id: lead.id,
        added_tags: merged.added,
        ...(merged.removed.length ? { removed_tags: merged.removed } : {}),
        tags: merged.tags,
      });
      if (merged.added.length || merged.removed.length) {
        await client.query(
          "update crm_leads set tags=$4,updated_at=clock_timestamp() where organization_id=$1 and contact_id=$2 and id=$3",
          [row.organization_id, row.contact_id, lead.id, merged.tags],
        );
        if (merged.added.length) await client.query("select emit_event($1,$2,$3,$4,$5,$6)", [
          "lead.tag_added",
          "crm_lead",
          lead.id,
          {
            added_tags: merged.added,
            tags: merged.tags,
            service_origin: { kind: "continuation", boundary: row.service_boundary },
          },
          {
            caused_by_rule: `followup:${row.id}`,
            execution_step_id: handle.step_id,
            execution_attempt_id: handle.attempt_id,
          },
          row.organization_id,
        ]);
        const activity = buildLeadActivityRow({
          organizationId: row.organization_id,
          leadId: lead.id,
          contactId: row.contact_id,
          type: "lead_edited",
          sourceModule: "crm",
          sourceId: lead.id,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: "Alterou as tags",
          payload: { fields: ["tags"] },
        });
        await client.query(
          `insert into crm_lead_activities
          (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
          values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
          [
            activity.organization_id,
            activity.lead_id,
            activity.contact_id,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            activity.payload,
          ],
        );
        await this.auditEffect(client, row.organization_id, "lead.updated", "crm_lead", lead.id, {
          fields: ["tags"],
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
      }
      await this.confirmLocalEffect(client, row, handle, "add_tag", output);
      return { output, reused: false };
    });
  }

  async completeProduct(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(client, scope, handle, "lead_product", NODE_OUTPUT_CONTRACTS.lead_product);
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "lead_product") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      await this.holdAttempt(client, row, handle);
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      if (!node.config.product_id) throw new ExecutionTaskConfigurationError("produto_ausente");
      const lead = (
        await client.query<{ id: string }>(
          "select id from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for update",
          [row.organization_id, row.contact_id, row.lead_id],
        )
      ).rows[0];
      if (!lead) throw new ExecutionLeadUnavailableError();
      // O produto precisa ser do catálogo DESTA organização — nome e preço vêm dele, nunca da configuração.
      const produto = (
        await client.query<{ id: string; nome: string; preco_cents: string | number }>(
          "select id,nome,preco_cents from catalog_products where organization_id=$1 and id=$2",
          [row.organization_id, node.config.product_id],
        )
      ).rows[0];
      if (!produto)
        throw new ExecutionTaskConfigurationError(
          "produto_indisponivel",
          "O produto escolhido não existe mais no catálogo. Escolha outro no bloco.",
        );
      let itemId: string | null = null;
      let removidos = 0;
      if (node.config.acao === "remove") {
        const r = await client.query(
          "delete from crm_lead_products where organization_id=$1 and lead_id=$2 and product_id=$3",
          [row.organization_id, lead.id, produto.id],
        );
        removidos = r.rowCount ?? 0;
      } else {
        itemId = randomUUID();
        await client.query(
          `insert into crm_lead_products (id,organization_id,lead_id,product_id,nome,preco_unitario_cents,quantidade)
           values($1,$2,$3,$4,$5,$6,$7)`,
          [itemId, row.organization_id, lead.id, produto.id, produto.nome, Number(produto.preco_cents), node.config.quantidade],
        );
      }
      if (itemId || removidos > 0) {
        await this.auditEffect(
          client,
          row.organization_id,
          itemId ? "lead_product.added" : "lead_product.removed",
          "crm_lead_products",
          itemId ?? lead.id,
          {
            lead_id: lead.id,
            product_id: produto.id,
            origem: `followup:${row.id}`,
            execution_step_id: handle.step_id,
            execution_attempt_id: handle.attempt_id,
          },
        );
        const activity = buildLeadActivityRow({
          organizationId: row.organization_id,
          leadId: lead.id,
          contactId: row.contact_id,
          type: "lead_edited",
          sourceModule: "crm",
          sourceId: lead.id,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: itemId ? `Acrescentou o produto ${produto.nome}` : `Tirou o produto ${produto.nome}`,
          payload: { fields: ["produtos"], product_id: produto.id },
        });
        await client.query(
          `insert into crm_lead_activities
          (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
          values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
          [
            activity.organization_id,
            activity.lead_id,
            activity.contact_id,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            activity.payload,
          ],
        );
      }
      const output = NODE_OUTPUT_CONTRACTS.lead_product.parse({
        lead_id: lead.id,
        product_id: produto.id,
        acao: node.config.acao,
        item_id: itemId,
        removidos,
      });
      await this.confirmLocalEffect(client, row, handle, "lead_product", output);
      return { output, reused: false };
    });
  }

  async completeField(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(
        client,
        scope,
        handle,
        "update_lead_field",
        NODE_OUTPUT_CONTRACTS.update_lead_field,
      );
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "update_lead_field") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: fieldReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.erro || reads.valor === null)
        throw new ExecutionTaskConfigurationError("campo_do_negocio_invalido", reads.erro ?? "O valor ficou vazio.");
      if (reads.alvo === "contact_field") {
        // Campo do CONTATO: mescla atômica na linha travada do contato; não precisa de negócio.
        const contato = (
          await client.query<{ id: string; custom_fields: Record<string, unknown> | null }>(
            "select id,custom_fields from contacts where organization_id=$1 and id=$2 for update",
            [row.organization_id, row.contact_id],
          )
        ).rows[0];
        if (!contato) throw new ExecutionLeadUnavailableError();
        const anteriorDoContato = (contato.custom_fields ?? {})[reads.chave!] ?? null;
        await client.query(
          `update contacts set custom_fields=coalesce(custom_fields,'{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
             updated_at=clock_timestamp() where organization_id=$1 and id=$2`,
          [row.organization_id, contato.id, reads.chave, JSON.stringify(reads.valor)],
        );
        await this.auditEffect(client, row.organization_id, "contact.updated", "contact", contato.id, {
          fields: [`custom_fields.${reads.chave}`],
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
        const saida = NODE_OUTPUT_CONTRACTS.update_lead_field.parse({
          lead_id: row.lead_id,
          contact_id: contato.id,
          alvo: reads.alvo,
          chave: reads.chave,
          valor: reads.valor,
          valor_anterior: anteriorDoContato as never,
        });
        await this.confirmLocalEffect(client, row, handle, "update_lead_field", saida);
        return { output: saida, reused: false };
      }
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      const lead = (
        await client.query<{ id: string; custom_fields: Record<string, unknown> | null; value_cents: number | null }>(
          "select id,custom_fields,value_cents from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for update",
          [row.organization_id, row.contact_id, row.lead_id],
        )
      ).rows[0];
      if (!lead) throw new ExecutionLeadUnavailableError();
      const anterior =
        reads.alvo === "deal_value"
          ? // bigint chega do driver como texto: a saída do bloco guarda número.
            lead.value_cents === null
            ? null
            : Number(lead.value_cents)
          : ((lead.custom_fields ?? {})[reads.chave!] ?? null);
      if (reads.alvo === "deal_value") {
        await client.query(
          "update crm_leads set value_cents=$4,updated_at=clock_timestamp() where organization_id=$1 and contact_id=$2 and id=$3",
          [row.organization_id, row.contact_id, lead.id, reads.valor],
        );
      } else {
        // Mescla atômica na linha travada: só a chave do bloco muda; as outras ficam como estão.
        await client.query(
          `update crm_leads set custom_fields=coalesce(custom_fields,'{}'::jsonb) || jsonb_build_object($4::text, $5::jsonb),
             updated_at=clock_timestamp() where organization_id=$1 and contact_id=$2 and id=$3`,
          [row.organization_id, row.contact_id, lead.id, reads.chave, JSON.stringify(reads.valor)],
        );
      }
      const campo = reads.alvo === "deal_value" ? "value_cents" : `custom_fields.${reads.chave}`;
      const activity = buildLeadActivityRow({
        organizationId: row.organization_id,
        leadId: lead.id,
        contactId: row.contact_id,
        type: "lead_edited",
        sourceModule: "crm",
        sourceId: lead.id,
        actor: { type: "webhook_source", id: `followup:${row.id}` },
        reason: reads.alvo === "deal_value" ? "Atualizou o valor do negócio" : "Atualizou um campo do negócio",
        payload: { fields: [campo] },
      });
      await client.query(
        `insert into crm_lead_activities
        (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
        values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
        [
          activity.organization_id,
          activity.lead_id,
          activity.contact_id,
          activity.type,
          activity.source_module,
          activity.source_id,
          activity.actor_kind,
          activity.reason,
          activity.payload,
        ],
      );
      await this.auditEffect(client, row.organization_id, "lead.updated", "crm_lead", lead.id, {
        fields: [campo],
        origem: `followup:${row.id}`,
        execution_step_id: handle.step_id,
        execution_attempt_id: handle.attempt_id,
      });
      const output = NODE_OUTPUT_CONTRACTS.update_lead_field.parse({
        lead_id: lead.id,
        alvo: reads.alvo,
        chave: reads.chave,
        valor: reads.valor,
        valor_anterior: anterior as never,
      });
      await this.confirmLocalEffect(client, row, handle, "update_lead_field", output);
      return { output, reused: false };
    });
  }

  async completeNote(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(client, scope, handle, "add_note", NODE_OUTPUT_CONTRACTS.add_note);
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "add_note") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: noteReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.erro) throw new ExecutionTaskConfigurationError("variavel_sem_valor", reads.erro);
      if (!reads.texto) throw new ExecutionTaskConfigurationError("nota_sem_texto", "A nota ficou sem texto.");
      const noteId = randomUUID();
      if (reads.destino === "lead_timeline") {
        if (!row.lead_id)
          throw new ExecutionTaskConfigurationError(
            "execution_lead_required",
            "Esta execução não tem negócio para receber a nota. Escolha a conversa como destino ou use um gatilho com negócio.",
          );
        const lead = (
          await client.query<{ id: string }>(
            "select id from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for share",
            [row.organization_id, row.contact_id, row.lead_id],
          )
        ).rows[0];
        if (!lead) throw new ExecutionLeadUnavailableError();
        const activity = buildLeadActivityRow({
          organizationId: row.organization_id,
          leadId: lead.id,
          contactId: row.contact_id,
          type: "note",
          sourceModule: "crm",
          sourceId: lead.id,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: reads.texto,
          payload: { origem: `followup:${row.id}`, execution_step_id: handle.step_id },
        });
        await client.query(
          `insert into crm_lead_activities
          (id,organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
          values($1,$2,$3,$4,$5,$6,$7,$8,null,$9,$10)`,
          [
            noteId,
            activity.organization_id,
            activity.lead_id,
            activity.contact_id,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            activity.payload,
          ],
        );
        await this.auditEffect(client, row.organization_id, "lead.updated", "crm_lead", lead.id, {
          fields: ["note"],
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
      } else {
        if (!row.conversation_id)
          throw new ExecutionTaskConfigurationError(
            "execution_conversation_required",
            "Esta execução não tem conversa para receber a nota. Escolha o negócio como destino.",
          );
        const conversa = (
          await client.query<{ id: string }>(
            "select id from conversations where organization_id=$1 and id=$2",
            [row.organization_id, row.conversation_id],
          )
        ).rows[0];
        if (!conversa)
          throw new ExecutionTaskConfigurationError("execution_conversation_required", "A conversa desta execução não existe mais.");
        await client.query(
          `insert into conversation_notes (id,organization_id,conversation_id,body,created_by_user_id,created_by_name)
           values($1,$2,$3,$4,null,$5)`,
          [noteId, row.organization_id, conversa.id, reads.texto, "Automação"],
        );
        await this.auditEffect(client, row.organization_id, "conversation.note_added", "conversation", conversa.id, {
          note_id: noteId,
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
      }
      const output = NODE_OUTPUT_CONTRACTS.add_note.parse({ destino: reads.destino, note_id: noteId, texto: reads.texto });
      await this.confirmLocalEffect(client, row, handle, "add_note", output);
      return { output, reused: false };
    });
  }

  async completeContactLookup(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const op = "find_or_create_contact";
      const receipt = await this.confirmedEffect(client, scope, handle, op, NODE_OUTPUT_CONTRACTS.find_or_create_contact);
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.current(client, scope);
      if (node.type !== "find_or_create_contact") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: contactLookupReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.erro) throw new ExecutionTaskConfigurationError("variavel_sem_valor", reads.erro);
      if (!reads.valor) throw new ExecutionTaskConfigurationError("busca_de_contato_sem_valor", "A busca ficou sem valor.");
      let telefone: string | null = null;
      let email: string | null = null;
      if (reads.busca === "phone") {
        if (phoneLookupVariants(reads.valor).length === 0)
          throw new ExecutionTaskConfigurationError("telefone_invalido", `«${reads.valor}» não é um telefone.`);
        telefone = canonicalPhoneBR(reads.valor);
      } else {
        email = reads.valor.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new ExecutionTaskConfigurationError("email_invalido", `«${reads.valor}» não é um e-mail.`);
      }
      const procurar = async () =>
        (
          await client.query<{ id: string }>(
            reads.busca === "phone"
              ? `select id from contacts where organization_id=$1 and phone_number = any($2::text[])
                 and is_merged_into is null and is_anonymized = false order by created_at asc limit 1`
              : `select id from contacts where organization_id=$1 and email_normalized = $2
                 and is_merged_into is null and is_anonymized = false order by created_at asc limit 1`,
            [row.organization_id, reads.busca === "phone" ? phoneLookupVariants(reads.valor!) : email],
          )
        ).rows[0]?.id ?? null;
      let contactId = await procurar();
      let criado = false;
      if (!contactId && reads.criar) {
        const novo = randomUUID();
        await client.query("savepoint criar_contato");
        try {
          await client.query(
            `insert into contacts (id,organization_id,name,display_name,phone_number,email,source,source_metadata)
             values($1,$2,$3,$3,$4,$5,'automation',$6)`,
            [novo, row.organization_id, reads.nome, telefone, email, { origem: `followup:${row.id}` }],
          );
          await client.query("release savepoint criar_contato");
          contactId = novo;
          criado = true;
        } catch (e) {
          await client.query("rollback to savepoint criar_contato");
          // Outro caminho criou o mesmo telefone/e-mail no meio: é o mesmo contato, não um erro.
          if ((e as { code?: string }).code !== "23505") throw e;
          contactId = await procurar();
          if (!contactId) throw e;
        }
        if (criado) {
          await client.query("select emit_event($1,$2,$3,$4,$5,$6)", [
            "contact.created",
            "contact",
            contactId,
            { source: "automation", has_email: !!email, has_phone: !!telefone },
            { caused_by_rule: `followup:${row.id}`, execution_step_id: handle.step_id, execution_attempt_id: handle.attempt_id },
            row.organization_id,
          ]);
          await this.auditEffect(client, row.organization_id, "contact.created", "contact", contactId, {
            origem: `followup:${row.id}`,
            execution_step_id: handle.step_id,
            execution_attempt_id: handle.attempt_id,
          });
        }
      }
      const output = NODE_OUTPUT_CONTRACTS.find_or_create_contact.parse({
        contact_id: contactId,
        encontrado: !!contactId && !criado,
        criado,
      });
      await this.confirmLocalEffect(client, row, handle, op, output);
      return { output, reused: false };
    });
  }

  async completeLeadLookup(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const op = "find_or_create_lead";
      const receipt = await this.confirmedEffect(client, scope, handle, op, NODE_OUTPUT_CONTRACTS.find_or_create_lead);
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.current(client, scope);
      if (node.type !== "find_or_create_lead") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: leadLookupReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.erro || !reads.contact_id) throw new ExecutionTaskConfigurationError("variavel_sem_valor", reads.erro ?? "Sem contato.");
      const contato = (
        await client.query<{ id: string; name: string | null; display_name: string | null; is_anonymized: boolean; kind: string | null }>(
          "select id,name,display_name,is_anonymized,kind from contacts where organization_id=$1 and id=$2 and is_merged_into is null for share",
          [row.organization_id, reads.contact_id],
        )
      ).rows[0];
      if (!contato || contato.is_anonymized || contato.kind === "whatsapp_group")
        throw new ExecutionTaskConfigurationError("contato_indisponivel", "O contato do negócio não existe nesta organização, foi anonimizado ou é um grupo.");
      const funil = (
        await client.query<{ id: string; settings: unknown }>(
          "select id,settings from crm_pipelines where organization_id=$1 and id=$2",
          [row.organization_id, reads.pipeline_id],
        )
      ).rows[0];
      if (!funil) throw new ExecutionTaskConfigurationError("negocio_sem_funil", "O funil escolhido não existe mais nesta organização.");
      let leadId =
        (
          await client.query<{ id: string }>(
            `select id from crm_leads where organization_id=$1 and contact_id=$2 and pipeline_id=$3 and status='open'
             order by created_at desc limit 1 for share`,
            [row.organization_id, contato.id, funil.id],
          )
        ).rows[0]?.id ?? null;
      let criado = false;
      if (!leadId && reads.criar) {
        const etapa = (
          await client.query<{ id: string; pipeline_id: string; is_won: boolean | null; is_lost: boolean | null }>(
            "select id,pipeline_id,is_won,is_lost from crm_stages where organization_id=$1 and id=$2 for share",
            [row.organization_id, reads.stage_id],
          )
        ).rows[0];
        if (!etapa || etapa.pipeline_id !== funil.id || etapa.is_won || etapa.is_lost)
          throw new ExecutionTaskConfigurationError("negocio_sem_etapa", "A etapa de entrada não é uma etapa aberta do funil escolhido.");
        const faltando = validaCamposExigidos({
          lead: { custom_fields: {} },
          settingsDoFunil: funil.settings,
          destino: { stageId: etapa.id, desfecho: null },
          motivoDeGanho: null,
        } as Parameters<typeof validaCamposExigidos>[0]).faltando;
        if (faltando.length)
          throw new ExecutionTaskConfigurationError(
            "campos_obrigatorios",
            `O funil exige ${faltando.map((f) => f.rotulo).join(", ")} para criar o negócio nesta etapa.`,
          );
        const titulo = (reads.titulo || contato.display_name || contato.name || "Negócio").slice(0, 200);
        leadId = randomUUID();
        await client.query(
          `insert into crm_leads (id,organization_id,pipeline_id,stage_id,title,contact_id,currency,status,source,source_metadata,position_in_stage)
           values($1,$2,$3,$4,$5,$6,coalesce((select currency from organizations where id=$2),'BRL'),'open','automation',$7,
             coalesce((select max(position_in_stage) from crm_leads where organization_id=$2 and stage_id=$4),0)+1000)`,
          [leadId, row.organization_id, funil.id, etapa.id, titulo, contato.id, { origem: `followup:${row.id}` }],
        );
        criado = true;
        const activity = buildLeadActivityRow({
          organizationId: row.organization_id,
          leadId,
          contactId: contato.id,
          type: "lead_created",
          sourceModule: "crm",
          sourceId: leadId,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: "Criado por automação",
          payload: { origem: `followup:${row.id}`, execution_step_id: handle.step_id, stage_id: etapa.id },
        });
        await client.query(
          `insert into crm_lead_activities
          (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
          values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
          [
            activity.organization_id,
            activity.lead_id,
            activity.contact_id,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            activity.payload,
          ],
        );
        await client.query("select emit_event($1,$2,$3,$4,$5,$6)", [
          "lead.created",
          "crm_lead",
          leadId,
          { pipeline_id: funil.id, stage_id: etapa.id, title: titulo, service_origin: { kind: "continuation", boundary: row.service_boundary } },
          { caused_by_rule: `followup:${row.id}`, execution_step_id: handle.step_id, execution_attempt_id: handle.attempt_id },
          row.organization_id,
        ]);
        await this.auditEffect(client, row.organization_id, "lead.created", "crm_lead", leadId, {
          pipeline_id: funil.id,
          stage_id: etapa.id,
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
      }
      const output = NODE_OUTPUT_CONTRACTS.find_or_create_lead.parse({
        lead_id: leadId,
        contact_id: contato.id,
        encontrado: !!leadId && !criado,
        criado,
      });
      await this.confirmLocalEffect(client, row, handle, op, output);
      return { output, reused: false };
    });
  }

  async prepareHttp(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(client, scope, handle, "http_request", NODE_OUTPUT_CONTRACTS.http_request);
      if (receipt) return { kind: "reused" as const, output: receipt };
      const { row, node } = await this.current(client, scope);
      if (node.type !== "http_request") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: httpReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.erro || !reads.url) throw new ExecutionTaskConfigurationError("requisicao_http_invalida", reads.erro ?? "A requisição ficou sem endereço.");
      const conexao = (
        await client.query<PedidoHttp["conexao"]>(
          `select base_url,auth_kind,header_name,secret_encrypted,secret_iv,secret_tag
           from automation_http_connections where organization_id=$1 and id=$2`,
          [row.organization_id, reads.connection_id],
        )
      ).rows[0];
      if (!conexao)
        throw new ExecutionTaskConfigurationError("conexao_http_ausente", "A conexão escolhida não existe mais nesta organização.");
      // O pedido foi congelado contra a origem de ANTES: se a conexão mudou de endereço, o segredo novo não vai para o antigo.
      if (new URL(reads.url).origin !== new URL(conexao.base_url).origin)
        throw new ExecutionTaskConfigurationError("conexao_http_mudou", "A conexão mudou de endereço depois que esta execução começou.");
      const chave = this.localEffectKey(row, handle, "http_request");
      const intencao = await client.query(
        `insert into followup_execution_effects (organization_id,enrollment_id,step_id,effect_key,operation,status)
         values($1,$2,$3,$4,'http_request','pending')
         on conflict (organization_id,effect_key) do update set status='pending',updated_at=clock_timestamp()
         where followup_execution_effects.status='failed' and followup_execution_effects.step_id=excluded.step_id
         returning id`,
        [row.organization_id, row.id, handle.step_id, chave],
      );
      if (intencao.rowCount !== 1) return { kind: "incerto" as const };
      return {
        kind: "pedido" as const,
        pedido: { conexao, metodo: reads.metodo, url: reads.url, corpo: reads.corpo ?? undefined, chave },
      };
    });
  }

  async completeHttp(scope: EnrollmentRow, handle: ExecutionAttemptHandle, resposta: NodeOutput<"http_request">) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(client, scope, handle, "http_request", NODE_OUTPUT_CONTRACTS.http_request);
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.current(client, scope);
      if (node.type !== "http_request") throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      const reads = z.object({ resolved: httpReadsSchema }).parse(held.input_snapshot).resolved;
      const output = NODE_OUTPUT_CONTRACTS.http_request.parse(resposta);
      await this.auditEffect(client, row.organization_id, "automation.http_request_sent", "automation_http_connection", reads.connection_id, {
        metodo: reads.metodo,
        status: output.status,
        origem: `followup:${row.id}`,
        execution_step_id: handle.step_id,
        execution_attempt_id: handle.attempt_id,
      });
      await this.confirmLocalEffect(client, row, handle, "http_request", output, true);
      return { output, reused: false };
    });
  }

  async failHttp(scope: EnrollmentRow, handle: ExecutionAttemptHandle, efeito: "failed" | "unknown", error: ExecutionError) {
    this.assertHandle(scope, handle);
    await this.transaction(async (client) => {
      await this.lockContact(client, scope);
      await client.query(
        `update followup_execution_effects set status=$4,updated_at=clock_timestamp()
         where organization_id=$1 and step_id=$2 and effect_key=$3 and status='pending'`,
        [scope.organization_id, handle.step_id, this.localEffectKey(scope, handle, "http_request"), efeito],
      );
    });
    await this.fail(scope, handle, error);
  }

  async completeOwner(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(
        client,
        scope,
        handle,
        "assign_owner",
        NODE_OUTPUT_CONTRACTS.assign_lead_owner,
      );
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "assign_lead_owner")
        throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      const usuario = node.config.usuario_id;
      if (!usuario) throw new ExecutionTaskConfigurationError("responsavel_ausente");
      const reads = z.object({ resolved: ownerReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.lead_id !== row.lead_id) throw new ExecutionLeadUnavailableError();
      const lead = (
        await client.query<{ id: string; owner_user_id: string | null; owner_agent_id: string | null }>(
          "select id,owner_user_id,owner_agent_id from crm_leads where organization_id=$1 and contact_id=$2 and id=$3 for update",
          [row.organization_id, row.contact_id, row.lead_id],
        )
      ).rows[0];
      if (!lead) throw new ExecutionLeadUnavailableError();
      // Alguém trocou o dono entre o begin e agora: a mudança humana vence; a tentativa relê.
      if (
        lead.owner_user_id !== reads.previous_owner_user_id ||
        lead.owner_agent_id !== reads.previous_owner_agent_id
      )
        throw new ExecutionInputChangedError();
      // Régua G3-04 (a mesma do bulk-assign e da ação assign_owner): vínculo não revogado e papel acima de viewer.
      const membro = (
        await client.query<{ role: string }>(
          "select role from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null and accepted_at is not null",
          [row.organization_id, usuario],
        )
      ).rows[0];
      if (!membro || membro.role === "viewer")
        throw new ExecutionTaskConfigurationError(
          "responsavel_indisponivel",
          "A pessoa escolhida não é um atendente ativo desta organização. Escolha outro responsável no bloco.",
        );
      const output = NODE_OUTPUT_CONTRACTS.assign_lead_owner.parse({
        lead_id: lead.id,
        previous_owner_user_id: lead.owner_user_id,
        owner_user_id: usuario,
      });
      if (lead.owner_user_id !== usuario || lead.owner_agent_id !== null) {
        const patch = resolveOwnerPatch({ owner_user_id: usuario });
        if (!patch.ok || !patch.patch) throw new ExecutionTaskConfigurationError("responsavel_indisponivel");
        await client.query(
          `update crm_leads set owner_user_id=$4,owner_agent_id=$5,owner_kind=$6,assigned_at=clock_timestamp(),updated_at=clock_timestamp()
           where organization_id=$1 and contact_id=$2 and id=$3`,
          [
            row.organization_id,
            row.contact_id,
            lead.id,
            patch.patch.owner_user_id,
            patch.patch.owner_agent_id,
            patch.patch.owner_kind,
          ],
        );
        const activity = buildLeadActivityRow({
          organizationId: row.organization_id,
          leadId: lead.id,
          contactId: row.contact_id,
          type: "lead_edited",
          sourceModule: "crm",
          sourceId: lead.id,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: "Trocou o responsável",
          payload: { fields: ["owner_user_id"], from: lead.owner_user_id, to: usuario },
        });
        await client.query(
          `insert into crm_lead_activities
          (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
          values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
          [
            activity.organization_id,
            activity.lead_id,
            activity.contact_id,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            activity.payload,
          ],
        );
        await this.auditEffect(client, row.organization_id, "lead.updated", "crm_lead", lead.id, {
          fields: ["owner_user_id"],
          origem: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        });
      }
      await this.confirmLocalEffect(client, row, handle, "assign_owner", output);
      return { output, reused: false };
    });
  }

  /** `destino: "contato"` do bloco de tag: mesma regra do negócio, gravada no contato da inscrição. */
  private async completeContactTags(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "edit_lead_tag" }>,
    handle: ExecutionAttemptHandle,
    held: { input_snapshot: unknown },
  ) {
    if (!node.config.tags.length) throw new ExecutionTaskConfigurationError("tag_ausente");
    const reads = z.object({ resolved: tagReadsSchema }).parse(held.input_snapshot).resolved;
    const contact = (
      await client.query<{ tags: string[] | null }>(
        "select tags from contacts where organization_id=$1 and id=$2 for update",
        [row.organization_id, row.contact_id],
      )
    ).rows[0];
    if (!contact) throw new ExecutionLeadUnavailableError();
    if (JSON.stringify(contact.tags ?? []) !== JSON.stringify(reads.previous_tags))
      throw new ExecutionInputChangedError();
    const merged = aplicarTags(reads.previous_tags, node.config.tags, node.config.acao);
    const output = NODE_OUTPUT_CONTRACTS.edit_lead_tag.parse({
      lead_id: row.lead_id,
      contact_id: row.contact_id,
      added_tags: merged.added,
      ...(merged.removed.length ? { removed_tags: merged.removed } : {}),
      tags: merged.tags,
    });
    if (merged.added.length || merged.removed.length) {
      await client.query(
        "update contacts set tags=$3,updated_at=clock_timestamp() where organization_id=$1 and id=$2",
        [row.organization_id, row.contact_id, merged.tags],
      );
      if (merged.added.length) await client.query("select emit_event($1,$2,$3,$4,$5,$6)", [
        "contact.tag_added",
        "contact",
        row.contact_id,
        {
          added_tags: merged.added,
          tags: merged.tags,
          service_origin: { kind: "continuation", boundary: row.service_boundary },
        },
        {
          caused_by_rule: `followup:${row.id}`,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        },
        row.organization_id,
      ]);
      await this.auditEffect(client, row.organization_id, "contact.updated", "contact", row.contact_id, {
        fields: ["tags"],
        origem: `followup:${row.id}`,
        execution_step_id: handle.step_id,
        execution_attempt_id: handle.attempt_id,
      });
    }
    await this.confirmLocalEffect(client, row, handle, "add_tag", output);
    return { output, reused: false };
  }

  async completeMove(scope: EnrollmentRow, handle: ExecutionAttemptHandle) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const receipt = await this.confirmedEffect(
        client,
        scope,
        handle,
        "move_lead",
        NODE_OUTPUT_CONTRACTS.move_lead,
      );
      if (receipt) return { output: receipt, reused: true };
      const { row, node } = await this.currentComAlvo(client, scope);
      if (node.type !== "move_lead")
        throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle);
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      const reads = z.object({ resolved: moveReadsSchema }).parse(held.input_snapshot).resolved;
      if (reads.lead?.id !== row.lead_id) throw new ExecutionLeadUnavailableError();
      if (!reads.stage) throw new ExecutionTaskConfigurationError("etapa_destino_inexistente");
      const currentLead = (
        await client.query<{ lead: unknown }>(
          "select to_jsonb(l) as lead from crm_leads l where l.organization_id=$1 and l.contact_id=$2 and l.id=$3 for update",
          [row.organization_id, row.contact_id, row.lead_id],
        )
      ).rows[0]?.lead;
      if (!currentLead) throw new ExecutionLeadUnavailableError();
      const lead = moveLeadReadSchema.parse(currentLead);
      const stage = (
        await client.query(
          "select id,pipeline_id,name,is_won,is_lost from crm_stages where organization_id=$1 and id=$2 for share",
          [row.organization_id, reads.stage.id],
        )
      ).rows[0];
      if (!stage) throw new ExecutionTaskConfigurationError("etapa_destino_inexistente");
      const pipeline = (
        await client.query<{ settings: unknown }>(
          "select settings from crm_pipelines where organization_id=$1 and id=$2 for share",
          [row.organization_id, reads.stage.pipeline_id],
        )
      ).rows[0];
      if (!pipeline) throw new ExecutionTaskConfigurationError("pipeline_unavailable");
      const parsedStage = moveStageReadSchema.parse(stage);
      if (
        lead.updated_at !== reads.lead.updated_at ||
        !isDeepStrictEqual(parsedStage, reads.stage) ||
        !isDeepStrictEqual(pipeline.settings ?? null, reads.settings)
      )
        throw new ExecutionInputChangedError();
      const prepared = prepararMovimentacaoDeLead({
        lead: reads.lead,
        etapa: reads.stage,
        settings: reads.settings,
        lost_reason: node.config.lost_reason,
        won_reason: node.config.won_reason,
        permitirTrocaDeFunil: true,
      });
      if (!prepared.ok)
        throw new ExecutionTaskConfigurationError(
          prepared.codigo,
          prepared.mensagem,
          prepared.details,
        );
      const positionRows = await client.query<{ max: string | null }>(
        "select max(position_in_stage)::text as max from crm_leads where organization_id=$1 and stage_id=$2",
        [row.organization_id, reads.stage.id],
      );
      const max = Number(positionRows.rows[0]?.max ?? 0),
        position = max ? max + 1000 : 1000;
      const values: unknown[] = [
        row.organization_id,
        row.contact_id,
        lead.id,
        reads.stage.id,
        position,
        lead.updated_at,
      ];
      const setters = ["stage_id=$4", "position_in_stage=$5", "updated_at=clock_timestamp()"];
      // Troca de funil: o MESMO negócio passa para o funil da etapa (id, conversa, tarefas e timeline seguem com ele).
      if (reads.stage.pipeline_id !== lead.pipeline_id) {
        values.push(reads.stage.pipeline_id);
        setters.push(`pipeline_id=$${values.length}`);
      }
      for (const field of ["lost_reason", "won_reason"] as const)
        if (prepared.patch[field] !== undefined) {
          values.push(prepared.patch[field]);
          setters.push(`${field}=$${values.length}`);
        }
      let updated: { stage_id: string; status: string } | undefined;
      try {
        updated = (
          await client.query<{ stage_id: string; status: string }>(
            `update crm_leads set ${setters.join(",")} where organization_id=$1 and contact_id=$2 and id=$3
           and updated_at=$6::timestamptz returning stage_id,status`,
            values,
          )
        ).rows[0];
      } catch (error) {
        const refusal = recusaDeMotivoDaPerdaPeloBanco(
          error as { code?: string; message?: string },
        );
        if (refusal) throw new ExecutionTaskConfigurationError(refusal.codigo, refusal.mensagem);
        throw error;
      }
      if (!updated) throw new ExecutionInputChangedError();
      const output = NODE_OUTPUT_CONTRACTS.move_lead.parse({
        lead_id: lead.id,
        from_stage_id: lead.stage_id,
        to_stage_id: updated.stage_id,
      });
      await client.query("select emit_event($1,$2,$3,$4,$5,$6)", [
        "lead.stage_changed",
        "crm_lead",
        lead.id,
        {
          pipeline_id: lead.pipeline_id,
          // Troca de funil (Fase 5): o funil de destino, para quem escuta o evento não ler o de origem como atual.
          ...(reads.stage.pipeline_id !== lead.pipeline_id ? { to_pipeline_id: reads.stage.pipeline_id } : {}),
          from_stage_id: lead.stage_id,
          to_stage_id: updated.stage_id,
          position_in_stage: position,
          status: updated.status,
          service_origin: { kind: "continuation", boundary: row.service_boundary },
        },
        {
          actor_type: "system",
          execution_id: row.id,
          execution_step_id: handle.step_id,
          execution_attempt_id: handle.attempt_id,
        },
        row.organization_id,
      ]);
      const activity = buildLeadActivityRow({
        organizationId: row.organization_id,
        leadId: lead.id,
        contactId: row.contact_id,
        type: "stage_changed",
        sourceModule: "crm",
        sourceId: lead.id,
        actor: { type: "webhook_source", id: `followup:${row.id}` },
        reason: stageChangeReason(reads.from_stage_name, reads.stage.name),
        payload: {
          from_stage_id: lead.stage_id,
          to_stage_id: updated.stage_id,
          pipeline_id: lead.pipeline_id,
        },
      });
      await client.query(
        `insert into crm_lead_activities
        (organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,performed_by_user_id,reason,payload)
        values($1,$2,$3,$4,$5,$6,$7,null,$8,$9)`,
        [
          activity.organization_id,
          activity.lead_id,
          activity.contact_id,
          activity.type,
          activity.source_module,
          activity.source_id,
          activity.actor_kind,
          activity.reason,
          activity.payload,
        ],
      );
      await this.confirmLocalEffect(client, row, handle, "move_lead", output);
      await this.auditEffect(client, row.organization_id, "lead.moved", "crm_lead", lead.id, {
        from_stage_id: lead.stage_id,
        to_stage_id: updated.stage_id,
        position_in_stage: position,
        execution_step_id: handle.step_id,
        execution_attempt_id: handle.attempt_id,
      });
      return { output, reused: false };
    });
  }

  /**
   * O tipo do nó em que a inscrição está, lido do grafo PINADO na versão. Serve para decidir se um
   * job órfão pode ser religado a uma tentativa que já tem outro job (só a classificação admite).
   */
  private async currentNodeType(
    client: pg.PoolClient,
    scope: EnrollmentRow,
  ): Promise<string | null> {
    const { rows } = await client.query<{ type: string | null }>(
      `select n->>'type' as type
       from followup_enrollments e
       join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
       cross join lateral jsonb_array_elements(v.graph->'nodes') n
       where e.organization_id=$1 and e.id=$2 and n->>'id'=e.current_node_id
       limit 1`,
      [scope.organization_id, scope.id],
    );
    return rows[0]?.type ?? null;
  }

  /**
   * A tentativa a que um job pertence: pelo vínculo (`job_id` da 0705 ou a tabela da 0706) e, se o
   * vínculo nunca aconteceu, pelo payload do próprio job na fila (o `attachJob` é uma transação
   * separada do enfileiramento). `multi` permite religar um job a uma tentativa que já tem OUTRO
   * job (reenfileiramento da classificação), o que o envio nunca pode.
   */
  private async attemptOfJob(
    client: pg.PoolClient,
    scope: EnrollmentRow,
    jobId: string,
    multi = false,
  ): Promise<
    | {
        id: string;
        step_id: string;
        status: string;
        node_id: string;
        visit: number;
        step_status: string;
        output_snapshot: unknown;
      }
    | undefined
  > {
    type Found = {
      id: string;
      step_id: string;
      status: string;
      node_id: string;
      visit: number;
      step_status: string;
      output_snapshot: unknown;
    };
    const { rows: linked } = await client.query<Found>(
      `select a.id,a.step_id,a.status,s.node_id,s.visit,s.status as step_status,a.output_snapshot
       from followup_execution_attempts a
       join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
       where a.organization_id=$1 and s.enrollment_id=$3
         and (a.job_id=$2 or exists (select 1 from followup_execution_attempt_jobs aj
              where aj.organization_id=a.organization_id and aj.attempt_id=a.id and aj.job_id=$2))
       order by a.attempt_no desc limit 1 for update of a,s`,
      [scope.organization_id, jobId, scope.id],
    );
    if (linked[0]) return linked[0];
    // O vínculo falhou depois de o job entrar na fila (enqueue e attach são transações
    // separadas e o replay do motor não religa): sem isto o envio sai e a conclusão
    // nunca acha a tentativa. A identidade do job vem do payload da própria fila.
    const { rows: owned } = await client.query<{ node_id: string; created_at: string }>(
      `select payload->>'node_id' as node_id, created_at::text as created_at from job_queue
       where organization_id=$1 and id=$2 and kind='followup_turn' and contact_id=$4
         and payload->>'followup_enrollment_id'=$3`,
      [scope.organization_id, jobId, scope.id, scope.contact_id],
    );
    if (owned[0]?.node_id !== scope.current_node_id) return undefined;
    const { rows: open } = await client.query<Found>(
      `select a.id,a.step_id,a.status,s.node_id,s.visit,s.status as step_status,a.output_snapshot
       from followup_execution_attempts a
       join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
       where a.organization_id=$1 and s.enrollment_id=$2 and s.node_id=$3
         and ($5::boolean or a.job_id is null) and a.status='running' and s.status='running'
         and a.started_at <= $4::timestamptz
       order by a.attempt_no desc limit 1 for update of a,s`,
      // A passagem não vem no payload de forma confiável (rechecagens também sobem
      // steps_taken): o job só pode pertencer a uma tentativa iniciada ANTES dele. Um job
      // órfão de visita anterior do mesmo nó nasceu antes da tentativa atual e é recusado.
      [scope.organization_id, scope.id, scope.current_node_id, owned[0].created_at, multi],
    );
    if (!open[0]) return undefined;
    await client.query(
      "update followup_execution_attempts set job_id=$3 where organization_id=$1 and id=$2 and job_id is null",
      [scope.organization_id, open[0].id, jobId],
    );
    await client.query(
      "insert into followup_execution_attempt_jobs (organization_id,attempt_id,job_id) values ($1,$2,$3) on conflict do nothing",
      [scope.organization_id, open[0].id, jobId],
    );
    return open[0];
  }

  async completeSend(
    scope: EnrollmentRow,
    jobId: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ) {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const attempt = await this.attemptOfJob(client, scope, jobId);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status === "succeeded") {
        // O snapshot pode ter sido expurgado/redigido (LGPD, retenção): repetir não falha por isso.
        const kept = NODE_OUTPUT_CONTRACTS.action.safeParse(attempt.output_snapshot);
        return { output: kept.success ? kept.data : null, reused: true };
      }
      const { row, node } = await this.current(client, scope);
      if (
        node.type !== "action" ||
        node.id !== attempt.node_id ||
        attempt.status !== "running" ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      // O recibo é o ledger: só mensagem ACEITA pelo canal conta, e com o id do CRM.
      const { rows: accepted } = await client.query<{ message_id: string; accepted_at: Date }>(
        `select l.crm_message_id as message_id, coalesce(m.sent_at, l.updated_at) as accepted_at
         from send_ledger l
         left join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
         where l.organization_id=$1 and l.job_id=$2 and l.status='accepted' and l.crm_message_id is not null
         order by l.seq`,
        [row.organization_id, jobId],
      );
      if (accepted.length === 0)
        throw new ExecutionTaskConfigurationError(
          "execution_send_receipt_missing",
          "O canal ainda não confirmou o envio desta mensagem.",
        );
      const output = NODE_OUTPUT_CONTRACTS.action.parse({
        messages: accepted.map((m) => ({
          message_id: m.message_id,
          accepted_at: new Date(m.accepted_at).toISOString(),
        })),
      });
      const handle = {
        organization_id: row.organization_id,
        enrollment_id: row.id,
        step_id: attempt.step_id,
        attempt_id: attempt.id,
        node_id: node.id,
        visit: attempt.visit,
        attempt_no: 0,
        lease_revision: Number(row.revision),
      } satisfies ExecutionAttemptHandle;
      await client.query(
        `insert into followup_execution_effects
          (organization_id,enrollment_id,step_id,effect_key,operation,status,result_snapshot,external_ref)
         values ($1,$2,$3,$4,'send_message','confirmed',$5,$6)`,
        [
          row.organization_id,
          row.id,
          attempt.step_id,
          this.localEffectKey(row, handle, "send_message"),
          output,
          accepted[0]!.message_id,
        ],
      );
      await client.query(
        `update followup_execution_attempts set status='succeeded',completed_at=clock_timestamp(),
          output_snapshot=$3,output_recorded=true where organization_id=$1 and id=$2`,
        [row.organization_id, attempt.id, output],
      );
      const graph = flowGraphSchema.parse(row.pinned_graph);
      const edge = selectEdge(graph.edges, node.id, { type: "always" });
      if (!edge) throw new ExecutionTaskConfigurationError("execution_outbound_edge_missing");
      await client.query(
        "update followup_execution_steps set status='succeeded',branch_id=$3,completed_at=clock_timestamp() where organization_id=$1 and id=$2",
        [row.organization_id, attempt.step_id, branchOfSelectedEdge(edge)],
      );
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        {
          current_node_id: edge.target,
          status: "active",
          next_eval_at: await this.dbNow(client),
          steps_taken: row.steps_taken + 1,
          claimed_until: null,
          attempts: 0,
          last_error: null,
        },
        {
          ...(jobClaim ? { job_id: jobId, job_claim: jobClaim } : {}),
          node_id: node.id,
          event_type: "action_sent",
          payload: { step_id: attempt.step_id, attempt_id: attempt.id },
          idempotency_key: `${node.id}:${row.steps_taken}`,
        },
      ]);
      return { output, reused: false };
    });
  }

  /**
   * Conclui a classificação feita pelo modelo para o job dado: a aresta vem da classe, o output é
   * o contrato do nó e o avanço usa o evento `ai_classified` (o que `ultimoDesfechoDe` lê). O
   * primeiro job a concluir vence; os demais (reenfileirados) devolvem `reused` e não gravam nada.
   */
  async completeClassification(
    scope: EnrollmentRow,
    jobId: string,
    classification: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ) {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const attempt = await this.attemptOfJob(client, scope, jobId, true);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status === "succeeded") {
        const kept = NODE_OUTPUT_CONTRACTS.ai_classify.safeParse(attempt.output_snapshot);
        return { output: kept.success ? kept.data : null, reused: true };
      }
      const { row, node } = await this.current(client, scope);
      if (
        node.type !== "ai_classify" ||
        node.id !== attempt.node_id ||
        attempt.status !== "running" ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      const graph = flowGraphSchema.parse(row.pinned_graph);
      const edge = selectEdge(graph.edges, node.id, classEdgeMatch(node, classification));
      if (!edge)
        throw new ExecutionTaskConfigurationError(
          "execution_edge_missing",
          "Não há ramo para a classe escolhida nem um ramo padrão.",
        );
      const output = NODE_OUTPUT_CONTRACTS.ai_classify.parse({
        classification,
        branch_id: branchOfSelectedEdge(edge),
        reason: "classified",
      });
      await this.finishClassification(client, row, node.id, attempt, edge, output, output.branch_id, {
        event_type: "ai_classified",
        payload: { class: classification },
        jobId,
        jobClaim,
      });
      return { output, reused: false };
    });
  }

  async completePlan(
    scope: EnrollmentRow,
    jobId: string,
    plan: TimingPlan,
    jobClaim?: { worker_id: string; acquired_at: string },
  ) {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const attempt = await this.attemptOfJob(client, scope, jobId, false);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status === "succeeded") {
        const kept = NODE_OUTPUT_CONTRACTS.trigger.safeParse(attempt.output_snapshot);
        return { output: kept.success ? kept.data : null, reused: true };
      }
      const { row, node } = await this.current(client, scope);
      if (
        node.type !== "trigger" ||
        node.id !== attempt.node_id ||
        attempt.status !== "running" ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      const graph = flowGraphSchema.parse(row.pinned_graph);
      const edge = selectEdge(graph.edges, node.id, { type: "always" });
      if (!edge)
        throw new ExecutionTaskConfigurationError(
          "execution_edge_missing",
          "O início do fluxo não tem saída.",
        );
      const output = NODE_OUTPUT_CONTRACTS.trigger.parse({
        contact_id: row.contact_id,
        lead_id: row.lead_id,
        conversation_id: row.conversation_id,
      });
      await this.finishClassification(
        client,
        row,
        node.id,
        attempt,
        edge,
        output,
        branchOfSelectedEdge(edge),
        // O plano inteiro no evento (a timeline se lê sozinha) e na coluna que as esperas leem.
        { event_type: "timing_plan_decidido", payload: { ...plan }, jobId, jobClaim },
        { timing_plan: plan },
      );
      return { output, reused: false };
    });
  }

  /**
   * A carência venceu sem resposta: o motor decide `no_reply` SEM chamar o modelo. O desfecho entra
   * como `node_advanced` com `class` (o outro escritor que `ultimoDesfechoDe` lê). Concluir a
   * tentativa em voo (que pode ter jobs na fila) deixa esses jobs obsoletos: eles voltam `reused`.
   */
  async completeNoReply(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: { next_node_id: string },
  ) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const done = await client.query<{ status: string }>(
        "select status from followup_execution_attempts where organization_id=$1 and id=$2",
        [scope.organization_id, handle.attempt_id],
      );
      if (done.rows[0]?.status === "succeeded") return { reused: true };
      const { row, node } = await this.current(client, scope);
      if (node.type !== "ai_classify")
        throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      await this.holdAttempt(client, row, handle);
      const graph = flowGraphSchema.parse(row.pinned_graph);
      const edge = selectEdge(graph.edges, node.id, classEdgeMatch(node, NO_REPLY_BRANCH_ID));
      if (!edge || edge.target !== result.next_node_id) throw new Error("execution_edge_mismatch");
      const output = NODE_OUTPUT_CONTRACTS.ai_classify.parse({
        classification: null,
        branch_id: branchOfSelectedEdge(edge),
        reason: "no_reply",
      });
      await this.finishClassification(
        client,
        row,
        node.id,
        { id: handle.attempt_id, step_id: handle.step_id },
        edge,
        output,
        output.branch_id,
        { event_type: "node_advanced", payload: { class: NO_REPLY_BRANCH_ID } },
      );
      return { reused: false };
    });
  }

  /** Fecha tentativa e passagem e avança a inscrição na MESMA transação. */
  private async finishClassification(
    client: pg.PoolClient,
    row: LockedExecution,
    nodeId: string,
    attempt: { id: string; step_id: string },
    edge: { id: string; target: string },
    output: unknown,
    branchId: string,
    event: {
      event_type: string;
      payload: Record<string, unknown>;
      jobId?: string;
      jobClaim?: { worker_id: string; acquired_at: string };
    },
    extraPatch: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `update followup_execution_attempts set status='succeeded',completed_at=clock_timestamp(),
        output_snapshot=$3,output_recorded=true where organization_id=$1 and id=$2`,
      [row.organization_id, attempt.id, output],
    );
    await client.query(
      "update followup_execution_steps set status='succeeded',branch_id=$3,completed_at=clock_timestamp() where organization_id=$1 and id=$2",
      [row.organization_id, attempt.step_id, branchId],
    );
    await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      row.organization_id,
      row.id,
      Number(row.revision),
      {
        current_node_id: edge.target,
        status: "active",
        next_eval_at: await this.dbNow(client),
        steps_taken: row.steps_taken + 1,
        claimed_until: null,
        attempts: 0,
        last_error: null,
        ...extraPatch,
      },
      {
        ...(event.jobClaim && event.jobId
          ? { job_id: event.jobId, job_claim: event.jobClaim }
          : {}),
        node_id: nodeId,
        event_type: event.event_type,
        payload: {
          ...event.payload,
          next_node_id: edge.target,
          edge_id: edge.id,
          step_id: attempt.step_id,
          attempt_id: attempt.id,
        },
        idempotency_key: `${nodeId}:${row.steps_taken}`,
      },
    ]);
  }

  /**
   * A pergunta de confirmação do `match_reply` (`if_exists: confirm`) saiu: o recibo é o ledger de
   * envio, e a tentativa passa a ESPERAR a resposta (a carência já corre desde o enfileiramento).
   * Não avança: quem avança é a resposta do lead, ou o fim da carência. Repetir é no-op.
   */
  async completeConfirmationSend(
    scope: EnrollmentRow,
    jobId: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }> {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const attempt = await this.attemptOfJob(client, scope, jobId);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status === "waiting") return { reused: true };
      const { row, node } = await this.current(client, scope);
      if (
        node.type !== "match_reply" ||
        node.id !== attempt.node_id ||
        attempt.status !== "running" ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      const { rows: accepted } = await client.query<{ message_id: string; accepted_at: Date }>(
        `select l.crm_message_id as message_id, coalesce(m.sent_at, l.updated_at) as accepted_at
         from send_ledger l
         left join messages m on m.organization_id=l.organization_id and m.id=l.crm_message_id
         where l.organization_id=$1 and l.job_id=$2 and l.status='accepted' and l.crm_message_id is not null
         order by l.seq`,
        [row.organization_id, jobId],
      );
      if (accepted.length === 0)
        throw new ExecutionTaskConfigurationError(
          "execution_send_receipt_missing",
          "O canal ainda não confirmou o envio desta mensagem.",
        );
      const output = {
        messages: accepted.map((m) => ({
          message_id: m.message_id,
          accepted_at: new Date(m.accepted_at).toISOString(),
        })),
      };
      const handle = {
        organization_id: row.organization_id,
        enrollment_id: row.id,
        step_id: attempt.step_id,
        attempt_id: attempt.id,
        node_id: node.id,
        visit: attempt.visit,
        attempt_no: 0,
        lease_revision: Number(row.revision),
      } satisfies ExecutionAttemptHandle;
      await client.query(
        `insert into followup_execution_effects
          (organization_id,enrollment_id,step_id,effect_key,operation,status,result_snapshot,external_ref)
         values ($1,$2,$3,$4,'send_message','confirmed',$5,$6)
         on conflict do nothing`,
        [
          row.organization_id,
          row.id,
          attempt.step_id,
          this.localEffectKey(row, handle, "send_message"),
          output,
          accepted[0]!.message_id,
        ],
      );
      // O lead precisa da carência INTEIRA depois que a pergunta saiu: o prazo é o maior entre o que o
      // enfileiramento gravou (pode já ter vencido, se o job ficou na fila) e aceite + carência.
      const aceite = new Date(accepted[0]!.accepted_at).getTime();
      const waitUntil = new Date(
        Math.max(
          aceite + node.config.grace_timeout_ms,
          row.next_eval_at ? new Date(row.next_eval_at).getTime() : 0,
        ),
      ).toISOString();
      await client.query(
        "update followup_execution_attempts set status='waiting',next_eval_at=$3 where organization_id=$1 and id=$2",
        [row.organization_id, attempt.id, waitUntil],
      );
      await client.query(
        "update followup_execution_steps set status='waiting' where organization_id=$1 and id=$2",
        [row.organization_id, attempt.step_id],
      );
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        { claimed_until: null, next_eval_at: waitUntil },
        {
          ...(jobClaim ? { job_id: jobId, job_claim: jobClaim } : {}),
          node_id: node.id,
          event_type: "confirmation_sent",
          payload: {
            step_id: attempt.step_id,
            attempt_id: attempt.id,
            message_id: accepted[0]!.message_id,
            accepted_at: new Date(accepted[0]!.accepted_at).toISOString(),
          },
          idempotency_key: `${node.id}:${row.steps_taken}:confirmacao:${jobId}`,
        },
      ]);
      return { reused: false };
    });
  }

  /**
   * O turno de envio (ou de classificação) foi PULADO: opt-out, conversa inelegível, modelo que não
   * pode sair etc. A tentativa e a passagem fecham como `skipped` e a inscrição é cancelada, na mesma
   * transação — o que o caminho legado fazia sem registrar nada no diário. Repetir é no-op.
   */
  async completeSkipped(
    scope: EnrollmentRow,
    jobId: string,
    reason: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }> {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const multi = (await this.currentNodeType(client, scope)) === "ai_classify";
      const attempt = await this.attemptOfJob(client, scope, jobId, multi);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status !== "running") return { reused: true };
      const { row, node } = await this.current(client, scope);
      if (
        (node.type !== "action" && node.type !== "ai_classify" && node.type !== "match_reply") ||
        node.id !== attempt.node_id ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      await client.query(
        "update followup_execution_attempts set status='skipped',completed_at=clock_timestamp() where organization_id=$1 and id=$2",
        [row.organization_id, attempt.id],
      );
      await client.query(
        "update followup_execution_steps set status='skipped',completed_at=clock_timestamp() where organization_id=$1 and id=$2",
        [row.organization_id, attempt.step_id],
      );
      const now = await this.dbNow(client);
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        {
          status: "cancelled",
          cancel_reason: reason,
          completed_at: now,
          next_eval_at: null,
          steps_taken: row.steps_taken + 1,
          claimed_until: null,
        },
        {
          ...(jobClaim ? { job_id: jobId, job_claim: jobClaim } : {}),
          node_id: node.id,
          event_type: "turn_skipped",
          payload: { reason, step_id: attempt.step_id, attempt_id: attempt.id },
          idempotency_key: `${node.id}:${row.steps_taken}`,
        },
      ]);
      return { reused: false };
    });
  }

  /**
   * O envio foi ADIADO (janela de disparo, proteção de agenda): o job volta a `pending` apontando
   * `until` e o envio ainda vai acontecer. A tentativa continua ABERTA (é o mesmo job que vai
   * concluí-la) e `steps_taken` não sobe: o passo segue devendo a conclusão. Só o adiamento é
   * registrado, numa transação que antes confere que o job pertence a uma tentativa aberta, com a
   * mesma chave por job do caminho legado (o retry do mesmo job é no-op).
   */
  async deferSend(
    scope: EnrollmentRow,
    jobId: string,
    until: Date,
    returnAt: Date,
    reason: string,
    jobClaim?: { worker_id: string; acquired_at: string },
  ): Promise<{ reused: boolean }> {
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const multi = (await this.currentNodeType(client, scope)) === "ai_classify";
      const attempt = await this.attemptOfJob(client, scope, jobId, multi);
      if (!attempt) throw new ExecutionTaskConfigurationError("execution_attempt_not_linked");
      if (attempt.status !== "running") return { reused: true };
      const { row, node } = await this.current(client, scope);
      if (
        (node.type !== "action" && node.type !== "ai_classify" && node.type !== "match_reply") ||
        node.id !== attempt.node_id ||
        attempt.step_status !== "running"
      )
        throw new StaleServiceBoundaryError();
      // Retry do MESMO job (queda depois do commit): o evento de adiamento já existe e repeti-lo
      // estouraria a chave de idempotência. O legado trata como no-op ("não inseriu ⇒ retorna").
      const key = `${node.id}:${row.steps_taken}:adiado:${jobId}`;
      const dup = await client.query(
        "select 1 from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and idempotency_key=$3 limit 1",
        [row.organization_id, row.id, key],
      );
      if (dup.rows[0]) return { reused: true };
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        { next_eval_at: returnAt.toISOString(), claimed_until: null },
        {
          ...(jobClaim ? { job_id: jobId, job_claim: jobClaim } : {}),
          node_id: node.id,
          event_type: "action_deferred",
          payload: {
            until: until.toISOString(),
            next_eval_at: returnAt.toISOString(),
            reason,
          },
          idempotency_key: key,
        },
      ]);
      return { reused: false };
    });
  }

  async attachJob(scope: EnrollmentRow, handle: ExecutionAttemptHandle, jobId: string) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const { row, node } = await this.current(client, scope);
      await this.holdAttempt(client, row, handle, true);
      // O job precisa ser desta organização, desta inscrição e deste nó: o id
      // nunca é confiado sozinho.
      const { rows: jobs } = await client.query(
        `select 1 from job_queue where organization_id=$1 and id=$2 and kind='followup_turn'
           and contact_id=$5 and payload->>'followup_enrollment_id'=$3 and payload->>'node_id'=$4
           and payload->>'source_step_key'=$6
         for key share`,
        // source_step_key é a passagem (nó:steps_taken) do produtor: um job de visita anterior
        // do mesmo nó não pode ser ligado à tentativa atual.
        [
          row.organization_id,
          jobId,
          row.id,
          handle.node_id,
          row.contact_id,
          `${node.id}:${row.steps_taken}`,
        ],
      );
      if (!jobs[0]) throw new ExecutionTaskConfigurationError("execution_job_not_found");
      const { rows } = await client.query<{ job_id: string | null }>(
        "select job_id from followup_execution_attempts where organization_id=$1 and id=$2",
        [row.organization_id, handle.attempt_id],
      );
      const first = rows[0]?.job_id ?? null;
      // Só a classificação aceita mais de um job por tentativa; o envio, nunca (envio em dobro).
      if (first && first !== jobId && node.type !== "ai_classify")
        throw new ExecutionTaskConfigurationError("execution_job_conflict");
      const linked = await client.query(
        "insert into followup_execution_attempt_jobs (organization_id,attempt_id,job_id) values ($1,$2,$3) on conflict do nothing",
        [row.organization_id, handle.attempt_id, jobId],
      );
      // Job NOVO ligado = a reentrada chegou até o fim (resposta do contato que reenfileira a
      // classificação): zera o contador. Só o worker que morre ANTES de ligar o job acumula até o
      // limite; o que morre depois deixa um job na fila que normalmente conclui a tentativa sozinho —
      // e, se esse job nunca conclui, o teto CLASSIFY_MAX_LINKED_JOBS do `begin` fecha o laço.
      if (linked.rowCount)
        await client.query(
          "update followup_execution_attempts set reuse_count=0 where organization_id=$1 and id=$2 and reuse_count<>0",
          [row.organization_id, handle.attempt_id],
        );
      if (!first)
        await client.query(
          "update followup_execution_attempts set job_id=$3 where organization_id=$1 and id=$2 and job_id is null",
          [row.organization_id, handle.attempt_id, jobId],
        );
      return { reused: first === jobId || linked.rowCount === 0 };
    });
  }

  /** Estaciona no agendamento existente; a espera pertence à mesma passagem e tentativa. */
  async parkWait(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: Extract<NodeResult, { kind: "wait" }>,
  ) {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const { row, node } = await this.current(client, scope);
      if (node.type !== "wait" && node.type !== "match_reply")
        throw new ExecutionTaskConfigurationError("execution_node_type_mismatch");
      const held = await this.holdAttempt(client, row, handle, true);
      if (held.next_eval_at) return { reused: true };
      const scheduled = result.next_eval_at.toISOString();
      await client.query(
        "update followup_execution_attempts set status='waiting',next_eval_at=$3 where organization_id=$1 and id=$2",
        [row.organization_id, handle.attempt_id, scheduled],
      );
      await client.query(
        "update followup_execution_steps set status='waiting' where organization_id=$1 and id=$2",
        [row.organization_id, handle.step_id],
      );
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        {
          status: result.wake_status ?? "active",
          next_eval_at: scheduled,
          steps_taken: row.steps_taken + 1,
          claimed_until: null,
        },
        {
          node_id: node.id,
          event_type: "wait_started",
          idempotency_key: `${node.id}:${row.steps_taken}`,
          payload: {
            next_eval_at: scheduled,
            wake_status: result.wake_status ?? "active",
            step_id: handle.step_id,
            attempt_id: handle.attempt_id,
          },
        },
      ]);
      return { reused: false };
    });
  }

  /** Decisão pura: resultado e avanço são confirmados juntos, sem recibo de efeito fictício. */
  /**
   * Captação do `match_reply`, dentro da transação que conclui o passo. O destino é o do nó, com o
   * `{{volta}}` interpolado pelos eventos da própria inscrição (lidos aqui, não recebidos de fora).
   * Campo de negócio vai para o Lead EXPLÍCITO da inscrição: sem ele, falha fechada — nunca o
   * "Lead mais recente do contato" do caminho legado.
   */
  private async saveReply(
    client: pg.PoolClient,
    row: LockedExecution,
    node: Extract<FlowNode, { type: "match_reply" }>,
    capture: ReplyCapture,
  ) {
    if (!node.config.save_to) throw new Error("execution_capture_without_destination");
    const value = recorteDaResposta(capture.value);
    if (!value) return;
    const { rows: events } = await client.query<EnrollmentEventRef>(
      `select node_id, idempotency_key, event_type, payload from followup_enrollment_events
       where organization_id=$1 and enrollment_id=$2 order by created_at`,
      [row.organization_id, row.id],
    );
    const saveTo = interpolarDestino(node.config.save_to, events);
    if (saveTo.kind === "lead_custom") {
      if (!row.lead_id) throw new ExecutionTaskConfigurationError("execution_lead_required");
      const saved = await client.query(
        `update crm_leads
            set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($3::text, to_jsonb($4::text)),
                updated_at = now()
          where organization_id = $1 and id = $2`,
        [row.organization_id, row.lead_id, saveTo.key, value],
      );
      // Lead da inscrição que não existe mais: concluir "gravando" em nada seria perda silenciosa.
      if (!saved.rowCount) throw new ExecutionTaskConfigurationError("execution_lead_not_found");
      return;
    }
    await persistirRespostaFollowupPg((sql, params) => client.query(sql, params), {
      organization_id: row.organization_id,
      contact_id: row.contact_id,
      save_to: saveTo,
      value,
    });
  }

  async completeDecision(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    result: Extract<NodeResult, { kind: "advance" | "complete" }>,
    trace?: NodeDecisionTrace,
    capture?: ReplyCapture,
  ): Promise<{ reused: boolean }> {
    this.assertHandle(scope, handle);
    return this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const prior = await client.query<{ status: string }>(
        `select a.status from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and a.id=$2 and s.id=$3 and s.enrollment_id=$4 and s.node_id=$5`,
        [scope.organization_id, handle.attempt_id, handle.step_id, scope.id, handle.node_id],
      );
      if (prior.rows[0]?.status === "succeeded") return { reused: true };
      const { row, node } = await this.current(client, scope);
      const held = await this.holdAttempt(
        client,
        row,
        handle,
        node.type === "wait" || node.type === "match_reply",
      );
      let output: unknown;
      if (node.type === "condition" && result.kind === "advance") {
        const condition = NODE_OUTPUT_CONTRACTS.condition.parse(trace?.output);
        if (condition.branch_id !== trace?.branch_id) throw new Error("execution_branch_mismatch");
        output = condition;
      } else if (node.type === "match_reply" && result.kind === "advance") {
        const reply = NODE_OUTPUT_CONTRACTS.match_reply.parse(trace?.output);
        if (reply.branch_id !== trace?.branch_id) throw new Error("execution_branch_mismatch");
        output = reply;
        if (capture) await this.saveReply(client, row, node, capture);
      } else if (node.type === "repeat" && result.kind === "advance") {
        const repeat = NODE_OUTPUT_CONTRACTS.repeat.parse(trace?.output);
        if (repeat.branch_id !== trace?.branch_id) throw new Error("execution_branch_mismatch");
        output = repeat;
      } else if (node.type === "wait" && result.kind === "advance") {
        output = NODE_OUTPUT_CONTRACTS.wait.parse({
          mode: node.config.mode,
          scheduled_for: held.next_eval_at ? new Date(held.next_eval_at).toISOString() : null,
          resumed_at: result.next_eval_at.toISOString(),
        });
      } else if (node.type === "trigger" && result.kind === "advance") {
        output = NODE_OUTPUT_CONTRACTS.trigger.parse({
          contact_id: row.contact_id,
          lead_id: row.lead_id,
          conversation_id: row.conversation_id,
        });
      } else if (node.type === "map_data" && result.kind === "advance") {
        output = NODE_OUTPUT_CONTRACTS.map_data.parse(trace?.output);
      } else if (node.type === "end" && result.kind === "complete") {
        output = NODE_OUTPUT_CONTRACTS.end.parse({
          outcome: result.outcome,
          note: result.cancel_reason ?? null,
        });
      } else throw new Error("execution_decision_not_integrated");
      if (result.kind === "advance") {
        const graph = flowGraphSchema.parse(row.pinned_graph);
        const edge = graph.edges.find(
          (candidate) => candidate.id === trace?.edge_id && candidate.source === node.id,
        );
        if (
          !edge ||
          edge.target !== result.next_node_id ||
          branchOfSelectedEdge(edge) !== trace?.branch_id
        ) {
          throw new Error("execution_edge_mismatch");
        }
      }
      await client.query(
        `update followup_execution_attempts set status='succeeded',completed_at=clock_timestamp(),
          output_snapshot=$3,output_recorded=true where organization_id=$1 and id=$2`,
        [row.organization_id, handle.attempt_id, output],
      );
      await client.query(
        "update followup_execution_steps set status='succeeded',branch_id=$3,completed_at=clock_timestamp() where organization_id=$1 and id=$2",
        [row.organization_id, handle.step_id, trace?.branch_id ?? null],
      );
      const now = new Date().toISOString();
      const notice = avisoDeRecuperacaoEsgotada(row, result, false);
      if (notice)
        await client.query(SQL_AVISO_RECUPERACAO_ESGOTADA, [
          notice.organization_id,
          notice.appointment_id,
          notice.appointment_revision,
        ]);
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        {
          steps_taken: row.steps_taken + 1,
          claimed_until: null,
          last_error: null,
          attempts: 0,
          ...(result.kind === "advance"
            ? {
                current_node_id: result.next_node_id,
                status: "active",
                // `advance` é "agora" (o handler devolve o relógio do processo): usa o do banco.
                // Um instante realmente futuro, se algum handler o devolver, é preservado.
                next_eval_at:
                  result.next_eval_at.getTime() > Date.now()
                    ? result.next_eval_at.toISOString()
                    : await this.dbNow(client),
              }
            : {
                status: "completed",
                completed_at: now,
                next_eval_at: null,
                outcome: result.outcome,
                cancel_reason: result.cancel_reason ?? null,
              }),
        },
        {
          node_id: node.id,
          // Mesmo vocabulário do legado (`eventTypeFor`): a desistência do plano de tempo tem evento
          // PRÓPRIO, que o dossiê traduz ("seguiu sem o plano; cada espera usa o máximo").
          event_type:
            result.kind !== "advance"
              ? "flow_completed"
              : result.reason === "plan_timeout"
                ? "timing_plan_desistido"
                : "node_advanced",
          payload: {
            step_id: handle.step_id,
            attempt_id: handle.attempt_id,
            ...(result.kind === "advance"
              ? {
                  next_node_id: result.next_node_id,
                  edge_id: trace!.edge_id,
                  branch_id: trace!.branch_id,
                  ...(result.repeat
                    ? { repeat_index: result.repeat.index, repeat_total: result.repeat.total }
                    : {}),
                }
              : { outcome: result.outcome, cancel_reason: result.cancel_reason ?? null }),
          },
          idempotency_key: `${node.id}:${row.steps_taken}`,
        },
      ]);
      return { reused: false };
    });
  }

  /**
   * "Fallback erro": a falha definitiva do bloco vira um avanço pela aresta `on_error`, na mesma
   * transação que fecha a tentativa. Devolve `false` quando o bloco não tem a aresta (o chamador
   * então para a inscrição e abre o aviso na Central, como antes).
   */
  private async routeToErrorEdge(
    client: pg.PoolClient,
    row: LockedExecution,
    stepId: string,
    attemptId: string,
    code: string,
  ): Promise<boolean> {
    const graph = flowGraphSchema.parse(row.pinned_graph);
    const edge = graph.edges.find(
      (candidate) =>
        candidate.source === row.current_node_id &&
        candidate.condition.type === "branch" &&
        candidate.condition.branch_id === ON_ERROR_BRANCH_ID,
    );
    if (!edge) return false;
    await client.query(
      "update followup_execution_steps set branch_id=$3 where organization_id=$1 and id=$2",
      [row.organization_id, stepId, ON_ERROR_BRANCH_ID],
    );
    await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      row.organization_id,
      row.id,
      Number(row.revision),
      {
        steps_taken: row.steps_taken + 1,
        claimed_until: null,
        attempts: 0,
        last_error: code,
        current_node_id: edge.target,
        status: "active",
        next_eval_at: await this.dbNow(client),
      },
      {
        node_id: row.current_node_id,
        event_type: "execution_error_routed",
        payload: {
          code,
          step_id: stepId,
          attempt_id: attemptId,
          next_node_id: edge.target,
          edge_id: edge.id,
          branch_id: ON_ERROR_BRANCH_ID,
        },
        idempotency_key: `${row.current_node_id}:${row.steps_taken}:error_route:${attemptId}`,
      },
    ]);
    return true;
  }

  private async stop(
    client: pg.PoolClient,
    row: LockedExecution,
    stepId: string,
    attemptId: string,
    code: string,
    eventType: string,
  ): Promise<void> {
    await client.query(
      `insert into agent_inbox_items (organization_id,kind,severity,title,body,ref_kind,ref_id)
       values ($1,'followup_dead','warn','Uma automação precisa de revisão',$2,'followup_enrollment',$3)`,
      [
        row.organization_id,
        `A execução ${row.id} parou no nó ${row.current_node_id}: ${code}. Revise a execução antes de tentar novamente.`,
        row.id,
      ],
    );
    await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
      row.organization_id,
      row.id,
      Number(row.revision),
      {
        status: "dead",
        last_error: code,
        cancel_reason: code,
        next_eval_at: null,
        claimed_until: null,
        completed_at: new Date().toISOString(),
      },
      {
        node_id: row.current_node_id,
        event_type: eventType,
        payload: { code, step_id: stepId, attempt_id: attemptId },
        idempotency_key: `${row.current_node_id}:${row.steps_taken}:${eventType}:${attemptId}`,
      },
    ]);
  }

  /** Finaliza uma falha sem confirmar um efeito e sem sobrescrever tentativas terminais. */
  async fail(
    scope: EnrollmentRow,
    handle: ExecutionAttemptHandle,
    rawError: ExecutionError,
  ): Promise<void> {
    const error = executionErrorSchema.parse(rawError);
    if (
      scope.organization_id !== handle.organization_id ||
      scope.id !== handle.enrollment_id ||
      scope.current_node_id !== handle.node_id ||
      scope.revision !== handle.lease_revision
    )
      throw new StaleServiceBoundaryError();
    await this.transaction(async (client) => {
      await this.lockContact(client, scope);
      const { rows: attempts } = await client.query<{ status: string }>(
        `select a.status from followup_execution_attempts a
         join followup_execution_steps s on s.organization_id=a.organization_id and s.id=a.step_id
         where a.organization_id=$1 and a.id=$2 and s.id=$3 and s.enrollment_id=$4 and s.node_id=$5`,
        [scope.organization_id, handle.attempt_id, handle.step_id, scope.id, handle.node_id],
      );
      if (!attempts[0]) throw new StaleServiceBoundaryError();
      if (attempts[0].status !== "running" && attempts[0].status !== "waiting") return;
      const { row } = await this.current(client, scope);
      const attemptCount = row.attempts + 1;
      const retry =
        error.category === "transient" && error.retryable && attemptCount <= row.max_attempts;
      const status = error.category === "unknown" ? "unknown" : "failed";
      await client.query(
        `update followup_execution_attempts set status=$3,completed_at=clock_timestamp(),error_snapshot=$4
         where organization_id=$1 and id=$2 and lease_revision=$5`,
        [row.organization_id, handle.attempt_id, status, error, handle.lease_revision],
      );
      if (!retry) {
        await client.query(
          "update followup_execution_steps set status=$3,completed_at=clock_timestamp() where organization_id=$1 and id=$2",
          [row.organization_id, handle.step_id, status],
        );
        // Falha DEFINITIVA e conhecida: se o bloco tem "Fallback erro", o fluxo continua por ela.
        // Resultado incerto (`unknown`) nunca desvia: o efeito pode ter acontecido, e quem decide é a Central.
        if (
          status === "failed" &&
          (await this.routeToErrorEdge(client, row, handle.step_id, handle.attempt_id, error.code))
        )
          return;
        await this.stop(
          client,
          row,
          handle.step_id,
          handle.attempt_id,
          error.code,
          "execution_failed",
        );
        return;
      }
      await client.query(
        "update followup_execution_steps set status='running' where organization_id=$1 and id=$2",
        [row.organization_id, handle.step_id],
      );
      const next = new Date(
        Date.now() + BACKOFF_MS[Math.min(attemptCount - 1, BACKOFF_MS.length - 1)]!,
      );
      await client.query("select fn_followup_apply_step($1,$2,$3,$4,$5)", [
        row.organization_id,
        row.id,
        Number(row.revision),
        {
          attempts: attemptCount,
          last_error: error.code,
          next_eval_at: next.toISOString(),
          claimed_until: null,
        },
        {
          node_id: row.current_node_id,
          event_type: "execution_retry_scheduled",
          payload: { error, step_id: handle.step_id, attempt_id: handle.attempt_id },
          idempotency_key: `${row.current_node_id}:${row.steps_taken}:failed:${handle.attempt_no}`,
        },
      ]);
    });
  }
}
