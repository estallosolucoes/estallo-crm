"use client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useRealtimeChannel, type RealtimeStatus } from "@/hooks/realtime/useRealtimeChannel";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

/**
 * Os estados que `followup_enrollments.status` aceita — todos eles.
 *
 * É o ÚNICO union do TypeScript que enumera o conjunto inteiro: o
 * `EnrollmentStatus` do motor (`lib/followup/node-handlers.ts`) lista o que o
 * motor manipula, e o motor nunca escreve nem lê `paused_manual` (o claim filtra
 * `active|waiting_reply`). Por isso este é o par do banco em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`: status novo no
 * CHECK sem entrada aqui reprova o CI, em vez de virar uma linha na fila com
 * rótulo cru.
 */
export type FollowupEnrollmentStatus =
  | "active"
  | "waiting_reply"
  | "dormente"
  | "paused_handoff"
  | "paused_manual"
  // Roteiro de atendimento em andamento (0394): conduzido pelo turno do agente,
  // não pelo relógio. O motor de follow-up nunca o lê.
  | "coletando"
  | "completed"
  | "cancelled"
  | "dead";

export interface FollowupQueueRow {
  source: "enrollment" | "promise";
  id: string;
  contact: { id: string; name: string };
  flow_name: string | null;
  flow_id?: string | null;
  agent_name: string | null;
  node_or_reason: string;
  next_fire_at: string | null;
  status: string;
  detail: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  attempts?: number | null;
  steps_taken?: number | null;
  version_id?: string | null;
  mode?: string | null;
  reexecucao?: string | null;
}

export type FollowupExecutionMode = "production" | "simulation" | "test";

export interface FollowupQueueFilters {
  status?: FollowupEnrollmentStatus;
  pointer_id?: string;
  q?: string;
  /** Datas "AAAA-MM-DD": entrada da execução no intervalo (dia inteiro, UTC). */
  desde?: string;
  ate?: string;
  modo?: FollowupExecutionMode;
  versao?: string;
  lead?: string;
}

export interface FollowupQueueOptions {
  /** Atualização automática (polling) a cada `ms`; sem isto a lista só muda ao filtrar ou recarregar. */
  refetchMs?: number | false;
}

interface ListResponse {
  data: FollowupQueueRow[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

const QUEUE_LIMIT = 20;

export const followupQueueQueryKey = (filters: FollowupQueueFilters) =>
  ["followup", "queue", filters] as const;

export function useFollowupQueue(filters: FollowupQueueFilters = {}, options: FollowupQueueOptions = {}) {
  return useInfiniteQuery({
    queryKey: followupQueueQueryKey(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.status) qs.set("status", filters.status);
      if (filters.pointer_id) qs.set("pointer_id", filters.pointer_id);
      if (filters.q) qs.set("q", filters.q);
      for (const k of ["desde", "ate", "modo", "versao", "lead"] as const) {
        const v = filters[k];
        if (v) qs.set(k, v);
      }
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", String(QUEUE_LIMIT));
      try {
        return await apiClient.get<ListResponse>(`/api/v1/ai/followups/queue?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) => (last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined),
    staleTime: 15_000,
    refetchInterval: options.refetchMs ?? false,
  });
}

export function useCancelFollowupEnrollment() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "enrollments", "cancel"],
    mutationFn: async (enrollmentId: string) => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followups/enrollments/${enrollmentId}/cancel`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success(t("Follow-up cancelado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

/**
 * Desmarcar a PROMESSA — o retorno avulso que o agente combinou.
 *
 * Mutação separada da de enrollment porque são duas coisas diferentes no banco
 * e no significado: uma encerra a caminhada num fluxo publicado, a outra desfaz
 * uma promessa que o agente fez numa conversa. A fila mostra as duas juntas
 * (é o que o operador quer ver), mas unificar o comando faria um cancelamento
 * atingir a linha errada em silêncio.
 */
export function useCancelFollowupPromise() {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "promises", "cancel"],
    mutationFn: async (promiseId: string) => {
      const res = await apiClient.post<{ data: { id: string; status: string } }>(
        `/api/v1/ai/followups/promises/${promiseId}/cancel`,
        {},
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success(t("Retorno cancelado."));
    },
    onError: (err) => {
      showApiError(err);
    },
  });
}

/**
 * Execuções de UM fluxo ao vivo: assina `followup_enrollments` (publicação desde a migration 0715) filtrada pelo fluxo
 * e só INVALIDA a lista e o dossiê — o dado volta pela API, sob a RLS de sempre. O motor escreve na linha a cada passo,
 * então os eventos são agrupados: no máximo uma releitura por segundo. Devolve o status do canal para quem chama
 * escolher o polling de recuperação.
 */
export function useExecucoesAoVivo(flowId: string, enabled: boolean): RealtimeStatus {
  const qc = useQueryClient();
  const pendente = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendente.current) clearTimeout(pendente.current);
    },
    [],
  );
  const onChange = useCallback(() => {
    if (pendente.current) return;
    pendente.current = setTimeout(() => {
      pendente.current = null;
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      void qc.invalidateQueries({ queryKey: ["followup", "enrollment"] });
    }, 1_000);
  }, [qc]);
  const { status } = useRealtimeChannel({
    name: `followup-execucoes-${flowId}`,
    postgresChanges: { event: "*", schema: "public", table: "followup_enrollments", filter: `pointer_id=eq.${flowId}` },
    onChange,
    enabled,
    // O que mudou entre a busca inicial e o SUBSCRIBED não vem pelo canal.
    recuperarNaPrimeira: true,
  });
  return status;
}
