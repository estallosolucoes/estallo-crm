"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowsClockwise, MagnifyingGlass, Pause, Play, SkipForward, Trash } from "@/lib/ui/icons";
import {
  useFollowupEnrollment,
  useConduzirPassoAPasso,
  useIntervirNoFollowup,
  useReiniciarExecucao,
} from "@/hooks/followup/useFollowupEnrollment";
import {
  useCancelFollowupEnrollment,
  useExecucoesAoVivo,
  useFollowupQueue,
  type FollowupEnrollmentStatus,
  type FollowupExecutionMode,
  type FollowupQueueRow,
} from "@/hooks/followup/useFollowupQueue";
import { useT } from "@/hooks/i18n/useT";
import { duracaoCurta } from "@/lib/followup/duracao-curta";
import { descreveEvento, rotuloDoStatus, tipoDoNo, tomDoStatus } from "@/lib/followup/eventos-legiveis";
import { passosDosEventos } from "@/lib/followup/passos-dos-eventos";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { blocosComEfeito } from "@/lib/followup/efeitos-do-reinicio";
import { CANCELAVEL, PAUSAVEL, RETOMAVEL, VIVA } from "@/lib/followup/intervencao-possivel";
import { motivoDaEspera } from "@/lib/followup/motivo-da-espera";
import { cn } from "@/lib/utils";
import { randomId } from "@/lib/random-id";

import { Passo } from "../../enrollments/[id]/_components/CaminhoPercorrido";

/** O xyflow é pesado: só carrega quando a pessoa abre as execuções. */
const CaminhoNoCanvas = dynamic(
  () => import("../../enrollments/[id]/_components/CaminhoNoCanvas").then((m) => m.CaminhoNoCanvas),
  { ssr: false, loading: () => <Skeleton className="h-full min-h-[420px] w-full" /> },
);

const STATUS_FILTRAVEIS: FollowupEnrollmentStatus[] = [
  "active",
  "waiting_reply",
  "dormente",
  "paused_manual",
  "paused_handoff",
  "completed",
  "cancelled",
  "dead",
];

/** Atualização automática: curta o bastante para acompanhar uma execução andando. */
const ATUALIZACAO_AUTOMATICA_MS = 10_000;
/** Com o canal de pé, o polling só cobre evento perdido. */
const RECUPERACAO_COM_CANAL_MS = 60_000;

const MODOS_FILTRAVEIS: FollowupExecutionMode[] = ["production", "simulation", "test"];

interface Props {
  flowId: string;
  /** Versões publicadas do fluxo (da mais nova à mais antiga), para o filtro por versão. */
  versoes?: { id: string; created_at: string; numero: number }[];
  /** Execução aberta (vem da URL, para o recarregar preservar o que a pessoa estava olhando). */
  execucaoId: string | null;
  noId: string | null;
  onSelecionarExecucao: (id: string | null) => void;
  onSelecionarNo: (id: string | null) => void;
  onVoltarAoEditor: () => void;
}

function rotuloDoModo(m: FollowupExecutionMode, t: (s: string) => string): string {
  return m === "production" ? t("Produção") : m === "simulation" ? t("Simulação") : t("Teste");
}

function Cartao({ linha, ativa, onClick }: { linha: FollowupQueueRow; ativa: boolean; onClick: () => void }) {
  const t = useT();
  const duracao = duracaoCurta(linha.started_at, linha.completed_at, new Date());
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={ativa ? "true" : undefined}
        data-testid="execucao-do-fluxo"
        className={cn(
          "flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left hover:bg-surface-muted",
          ativa && "bg-surface-muted shadow-[inset_3px_0_0_var(--color-accent-500,#2563eb)]",
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{linha.contact.name}</span>
          <Badge variant={tomDoStatus(linha.status)}>{rotuloDoStatus(linha.status, t)}</Badge>
        </span>
        {linha.reexecucao && (
          <span className="text-[11px] text-accent" data-testid="execucao-e-reexecucao">
            {t("Reexecução")}
          </span>
        )}
        <span className="text-xs text-text-muted">
          {linha.started_at ? format(new Date(linha.started_at), "dd/MM HH:mm") : "—"}
          {duracao ? ` · ${duracao}` : ""}
          {linha.attempts && linha.attempts > 1 ? ` · ${linha.attempts} ${t("tentativas")}` : ""}
        </span>
      </button>
    </li>
  );
}

/**
 * O histórico DESTE fluxo, no próprio editor: a lista à esquerda (só as execuções dele), o desenho da execução escolhida
 * no meio — exatamente na versão que rodou — e o que aconteceu no bloco clicado à direita. Somente leitura: o desenho é
 * o da versão pinada, e as ações daqui (pausar, retomar, cancelar) são sobre a EXECUÇÃO, nunca sobre o fluxo.
 */
export function ExecucoesDoFluxo({
  flowId,
  versoes = [],
  execucaoId,
  noId,
  onSelecionarExecucao,
  onSelecionarNo,
  onVoltarAoEditor,
}: Props) {
  const t = useT();
  const [status, setStatus] = useState<FollowupEnrollmentStatus | "all">("all");
  const [modo, setModo] = useState<FollowupExecutionMode | "all">("all");
  const [versao, setVersao] = useState("all");
  const [desde, setDesde] = useState("");
  const [ate, setAte] = useState("");
  const [busca, setBusca] = useState("");
  const [q, setQ] = useState("");
  const [automatica, setAutomatica] = useState(true);
  const [confirmaCancelar, setConfirmaCancelar] = useState(false);
  const [confirmaReiniciar, setConfirmaReiniciar] = useState(false);
  // «Recuperar da falha» (Fase 6) usa o mesmo diálogo e a mesma rota, em outro modo.
  const [recuperar, setRecuperar] = useState(false);
  const [rodarPassoAPasso, setRodarPassoAPasso] = useState(false);
  // Um por abertura do diálogo: duplo clique em «Reexecutar» chega com a mesma chave e cria UMA reexecução.
  const chaveDoReinicio = useRef<string>("");

  useEffect(() => {
    const h = setTimeout(() => setQ(busca.trim()), 250);
    return () => clearTimeout(h);
  }, [busca]);

  const filtros = useMemo(
    () => ({
      pointer_id: flowId,
      status: status === "all" ? undefined : status,
      q: q || undefined,
      modo: modo === "all" ? undefined : modo,
      versao: versao === "all" ? undefined : versao,
      desde: desde || undefined,
      ate: ate || undefined,
    }),
    [flowId, status, q, modo, versao, desde, ate],
  );
  // Ao vivo pelo Realtime; o polling é a recuperação — curto se o canal não subiu, longo (só rede de segurança) se subiu.
  const canal = useExecucoesAoVivo(flowId, automatica);
  const fila = useFollowupQueue(filtros, {
    refetchMs: automatica ? (canal === "subscribed" ? RECUPERACAO_COM_CANAL_MS : ATUALIZACAO_AUTOMATICA_MS) : false,
  });
  const linhas = (fila.data?.pages.flatMap((p) => p.data) ?? []).filter((l) => l.source === "enrollment");

  const dossie = useFollowupEnrollment(execucaoId ?? "");
  const exec = execucaoId ? dossie.data : undefined;
  const intervir = useIntervirNoFollowup();
  const cancelar = useCancelFollowupEnrollment();
  const reiniciar = useReiniciarExecucao();
  const conduzir = useConduzirPassoAPasso();

  const tagDoIdioma = useTagDeIdioma();
  // Sem o diário passo a passo (contrato 0, o de hoje), o caminho é RECONSTRUÍDO dos eventos do motor: dá o estado de
  // cada bloco, mas não a entrada e a saída. Sem eventos também, o desenho não pode afirmar caminho nenhum.
  const reconstruido = useMemo(() => {
    if (!exec || exec.passos.length > 0) return [];
    return passosDosEventos(exec.eventos ?? [], Object.fromEntries(exec.nos.map((n) => [n.id, n])), {
      status: exec.status,
      currentNodeId: exec.current_node_id,
    });
  }, [exec]);
  const derivado = exec ? exec.passos.length === 0 && reconstruido.length > 0 : false;
  const passosEfetivos = exec ? (exec.passos.length > 0 ? exec.passos : reconstruido) : [];
  const semDiario = exec ? passosEfetivos.length === 0 : false;
  const nosPorId = useMemo(() => Object.fromEntries((exec?.nos ?? []).map((n) => [n.id, n])), [exec]);
  const espera = exec
    ? motivoDaEspera(
        {
          status: exec.status,
          next_eval_at: exec.next_eval_at,
          motor_ocupado: exec.motor_ocupado,
          attempts: exec.attempts,
          max_attempts: exec.max_attempts,
          rotuloDoBlocoAtual: exec.no_atual?.rotulo ?? null,
        },
        t,
        (iso) => format(new Date(iso), "dd/MM HH:mm"),
      )
    : null;
  const terminada = exec ? !VIVA.has(exec.status) : false;
  const reexecucaoViva = exec ? (exec.reexecucoes ?? []).some((r) => VIVA.has(r.status)) : false;
  const podeReiniciar = terminada && !reexecucaoViva;
  const efeitos = exec
    ? blocosComEfeito(
        exec.nos.map((n) => ({ id: n.id, rotulo: n.rotulo, tipo: n.tipo })),
        passosEfetivos,
      )
    : [];
  const noEscolhido = exec && noId ? (exec.nos.find((n) => n.id === noId) ?? null) : null;
  const passosDoNo = exec && noId ? passosEfetivos.filter((p) => p.node_id === noId) : [];
  // Bloco que rodou mais de uma vez (volta de Repetir, nova tentativa): uma passagem por vez, a mais recente por padrão.
  // A escolha vale para o bloco em que foi feita: trocar de bloco ou de execução volta à mais recente.
  const chaveDoBloco = `${execucaoId ?? ""}:${noId ?? ""}`;
  const [passagemEscolhida, setPassagemEscolhida] = useState<{ chave: string; i: number } | null>(null);
  const ultima = passosDoNo.length - 1;
  const passagem = passagemEscolhida?.chave === chaveDoBloco ? Math.min(passagemEscolhida.i, ultima) : ultima;
  const eventosDoNo = exec && noId && derivado ? (exec.eventos ?? []).filter((e) => e.node_id === noId) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" data-testid="execucoes-do-fluxo">
      {/* Lista */}
      <aside className="flex max-h-72 shrink-0 flex-col border-b border-border lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar contato…")}
              aria-label={t("Buscar contato")}
              className="h-9 pl-8 text-sm"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as FollowupEnrollmentStatus | "all")}>
            <SelectTrigger className="h-9 text-sm" aria-label={t("Filtrar por status")}>
              <SelectValue placeholder={t("Todos os status")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todos os status")}</SelectItem>
              {STATUS_FILTRAVEIS.map((s) => (
                <SelectItem key={s} value={s}>
                  {rotuloDoStatus(s, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={modo} onValueChange={(v) => setModo(v as FollowupExecutionMode | "all")}>
            <SelectTrigger className="h-9 text-sm" aria-label={t("Filtrar por modo")}>
              <SelectValue placeholder={t("Todos os modos")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Todos os modos")}</SelectItem>
              {MODOS_FILTRAVEIS.map((m) => (
                <SelectItem key={m} value={m}>
                  {rotuloDoModo(m, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {versoes.length > 0 && (
            <Select value={versao} onValueChange={setVersao}>
              <SelectTrigger className="h-9 text-sm" aria-label={t("Filtrar por versão")}>
                <SelectValue placeholder={t("Todas as versões")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Todas as versões")}</SelectItem>
                {versoes.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {t("Versão")} {v.numero} · {format(new Date(v.created_at), "dd/MM/yyyy")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={desde}
              max={ate || undefined}
              onChange={(e) => setDesde(e.target.value)}
              aria-label={t("Execuções a partir de")}
              className="h-9 text-xs"
            />
            <Input
              type="date"
              value={ate}
              min={desde || undefined}
              onChange={(e) => setAte(e.target.value)}
              aria-label={t("Execuções até")}
              className="h-9 text-xs"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <Switch checked={automatica} onCheckedChange={setAutomatica} aria-label={t("Atualizar automaticamente")} />
            {t("Atualizar automaticamente")}
            {automatica && canal === "subscribed" && (
              <span className="text-success-fg" data-testid="execucoes-ao-vivo">· {t("ao vivo")}</span>
            )}
          </label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t("Execuções deste fluxo")}>
          {fila.isLoading ? (
            <li className="p-3">
              <Skeleton className="h-12 w-full" />
            </li>
          ) : linhas.length === 0 ? (
            <li className="p-4 text-sm text-text-muted" data-testid="execucoes-vazio">
              {t("Este fluxo ainda não tem execuções.")}
            </li>
          ) : (
            linhas.map((l) => (
              <Cartao key={l.id} linha={l} ativa={l.id === execucaoId} onClick={() => onSelecionarExecucao(l.id)} />
            ))
          )}
          {fila.hasNextPage && (
            <li className="p-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => fila.fetchNextPage()}
                disabled={fila.isFetchingNextPage}
              >
                {fila.isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
              </Button>
            </li>
          )}
        </ul>
      </aside>

      {/* Desenho + inspetor */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!execucaoId ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-muted">
            {t("Escolha uma execução na lista para ver como o fluxo andou.")}
          </div>
        ) : dossie.isLoading || !exec ? (
          <div className="p-4">
            <Skeleton className="h-full min-h-[420px] w-full" />
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{exec.contact.name}</p>
                <p className="text-xs text-text-muted" data-testid="execucao-resumo">
                  {format(new Date(exec.started_at), "dd/MM/yyyy HH:mm")}
                  {" · "}
                  {duracaoCurta(exec.started_at, exec.completed_at, new Date()) ?? "—"}
                  {" · "}
                  {exec.steps_taken} {t("passos")}
                  {" · "}
                  {t("tentativa")} {Math.min(exec.attempts + 1, exec.max_attempts)}/{exec.max_attempts}
                </p>
              </div>
              <Badge variant={tomDoStatus(exec.status)}>{rotuloDoStatus(exec.status, t)}</Badge>
              {exec.origem && (
                <button
                  type="button"
                  className="text-xs text-accent underline-offset-[3px] hover:underline"
                  data-testid="execucao-origem"
                  onClick={() => onSelecionarExecucao(exec.origem!.id)}
                >
                  {exec.origem.tipo === "retry"
                    ? t("Recuperação — ver a execução original")
                    : t("Reexecução — ver a execução original")}
                </button>
              )}
              <span className="text-xs text-text-muted">{t("Somente leitura — esta é a versão que rodou.")}</span>
              <div className="ml-auto flex items-center gap-2">
                {PAUSAVEL.has(exec.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={intervir.isPending}
                    onClick={() => intervir.mutate({ id: exec.id, acao: "pause" })}
                  >
                    <Pause size={14} aria-hidden className="mr-1" /> {t("Pausar")}
                  </Button>
                )}
                {RETOMAVEL.has(exec.status) && !exec.passo_a_passo && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={intervir.isPending}
                    onClick={() => intervir.mutate({ id: exec.id, acao: "resume" })}
                  >
                    <Play size={14} aria-hidden className="mr-1" /> {t("Retomar")}
                  </Button>
                )}
                {terminada && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!podeReiniciar || reiniciar.isPending}
                    title={reexecucaoViva ? t("Já existe uma reexecução em andamento.") : undefined}
                    data-testid="reexecutar-inicio"
                    onClick={() => {
                      chaveDoReinicio.current = randomId();
                      setRodarPassoAPasso(false);
                      setRecuperar(false);
                      setConfirmaReiniciar(true);
                    }}
                  >
                    <ArrowsClockwise size={14} aria-hidden className="mr-1" /> {t("Reexecutar do início")}
                  </Button>
                )}
                {exec.status === "dead" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!podeReiniciar || reiniciar.isPending}
                    data-testid="recuperar-da-falha"
                    onClick={() => {
                      chaveDoReinicio.current = randomId();
                      setRodarPassoAPasso(false);
                      setRecuperar(true);
                      setConfirmaReiniciar(true);
                    }}
                  >
                    <SkipForward size={14} aria-hidden className="mr-1" /> {t("Recuperar da falha")}
                  </Button>
                )}
                {CANCELAVEL.has(exec.status) && (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmaCancelar(true)}>
                    <Trash size={14} aria-hidden className="mr-1 text-error" /> {t("Cancelar execução")}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onVoltarAoEditor}>
                  {t("Voltar ao editor")}
                </Button>
              </div>
            </header>

            {exec.passo_a_passo && (
              <div
                className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-4 py-2 text-sm"
                data-testid="execucao-passo-a-passo"
              >
                <span className="font-medium">{t("Execução passo a passo")}</span>
                {exec.status === "paused_manual" ? (
                  <>
                    <span className="text-text-muted">
                      {t("Próximo bloco")}: «{exec.no_atual?.rotulo ?? exec.current_node_id}»
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={conduzir.isPending}
                        data-testid="executar-proximo-bloco"
                        onClick={() => conduzir.mutate({ id: exec.id, acao: "proximo" })}
                      >
                        <SkipForward size={14} aria-hidden className="mr-1" /> {t("Executar próximo bloco")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={conduzir.isPending}
                        data-testid="continuar-automaticamente"
                        onClick={() => conduzir.mutate({ id: exec.id, acao: "continuar" })}
                      >
                        {t("Continuar automaticamente")}
                      </Button>
                    </div>
                  </>
                ) : VIVA.has(exec.status) ? (
                  <span className="text-text-muted">{t("Executando o bloco… a tela atualiza sozinha.")}</span>
                ) : null}
              </div>
            )}
            {(exec.reexecucoes ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs" data-testid="execucao-reexecucoes">
                <span className="text-text-muted">{t("Reexecuções desta execução")}:</span>
                {(exec.reexecucoes ?? []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="rounded-full border border-border px-2 py-0.5 hover:bg-surface-muted"
                    onClick={() => onSelecionarExecucao(r.id)}
                  >
                    {format(new Date(r.started_at), "dd/MM HH:mm")} · {rotuloDoStatus(r.status, t)}
                  </button>
                ))}
              </div>
            )}
            {espera && (
              <p className="border-b border-border px-4 py-2 text-xs text-text-muted" data-testid="execucao-espera">
                {espera}
              </p>
            )}
            {(exec.last_error || exec.cancel_reason) && (
              <p className="border-b border-border bg-error-bg px-4 py-2 text-xs text-error-fg" data-testid="execucao-erro">
                {exec.last_error ?? exec.cancel_reason}
              </p>
            )}
            {(exec.passos_herdados ?? []).length > 0 && (
              <div className="border-b border-border bg-surface-muted px-4 py-2 text-xs" data-testid="passos-herdados">
                <span className="font-medium">{t("Herdado da execução original:")}</span>{" "}
                {(exec.passos_herdados ?? []).map((p, i) => (
                  <Badge key={p.step_id} variant="neutral" className={cn(i > 0 && "ml-1")}>
                    {p.rotulo}
                  </Badge>
                ))}
              </div>
            )}
            {exec.passos_truncados && (
              <p className="border-b border-border bg-surface-muted px-4 py-2 text-xs text-text-muted" data-testid="execucao-diario-truncado">
                {t("Esta execução tem mais passos do que a tela carrega: o desenho mostra só os primeiros.")}
              </p>
            )}

            {derivado && (
              <p className="border-b border-border bg-surface-muted px-4 py-2 text-xs text-text-muted" data-testid="execucao-reconstruida">
                {t("Caminho reconstruído a partir dos eventos do motor: mostra por onde a execução passou, mas não guarda a entrada e a saída de cada bloco.")}
              </p>
            )}
            {semDiario && (
              <p className="border-b border-border bg-surface-muted px-4 py-2 text-xs text-text-muted" data-testid="execucao-sem-diario">
                {t("Esta execução é anterior ao registro passo a passo: o desenho mostra o fluxo, mas não o caminho que ela percorreu.")}
              </p>
            )}
            <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
              <div className="min-h-[360px] min-w-0 flex-1 p-3">
                {exec.grafo ? (
                  <CaminhoNoCanvas
                    grafo={exec.grafo}
                    passos={passosEfetivos}
                    onSelecionarNo={onSelecionarNo}
                    noSelecionado={noId}
                    altura="h-full min-h-[420px]"
                  />
                ) : (
                  <p className="p-4 text-sm text-text-muted" data-testid="execucao-sem-desenho">
                    {t("O desenho desta execução não está disponível para o seu perfil.")}
                  </p>
                )}
              </div>

              <aside
                className="max-h-[50vh] shrink-0 overflow-y-auto border-t border-border p-4 xl:max-h-none xl:w-96 xl:border-l xl:border-t-0"
                aria-label={t("O que aconteceu no bloco")}
                data-testid="execucao-inspetor"
              >
                {!noId ? (
                  <p className="text-sm text-text-muted">
                    {t("Clique num bloco do desenho para ver a entrada, a saída e o que aconteceu nele.")}
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div>
                      <p className="text-sm font-medium">{noEscolhido?.rotulo ?? noId}</p>
                      {noEscolhido && <p className="text-xs text-text-muted">{t(tipoDoNo(noEscolhido.tipo))}</p>}
                      {noEscolhido?.resumo && <p className="mt-1 text-xs text-text-muted">{noEscolhido.resumo}</p>}
                    </div>
                    {passosDoNo.length === 0 ? (
                      <p className="text-sm text-text-muted" data-testid="inspetor-nao-percorrido">
                        {semDiario
                          ? t("Não há registro do que aconteceu neste bloco.")
                          : t("Esta execução não passou por este bloco.")}
                      </p>
                    ) : (
                      <>
                      {passosDoNo.length > 1 && (
                        <div role="tablist" aria-label={t("Passagens por este bloco")} className="mb-3 flex flex-wrap gap-1">
                          {passosDoNo.map((p, i) => (
                            <button
                              key={p.step_id}
                              type="button"
                              role="tab"
                              aria-selected={i === passagem}
                              data-testid="inspetor-passagem"
                              onClick={() => setPassagemEscolhida({ chave: chaveDoBloco, i })}
                              className={cn(
                                "rounded-md border px-2 py-1 text-xs",
                                i === passagem ? "border-accent bg-surface-muted font-medium" : "border-border text-text-muted hover:text-text",
                              )}
                            >
                              {t("Passagem")} {i + 1}
                              {p.entered_at ? ` · ${format(new Date(p.entered_at), "dd/MM HH:mm")}` : ""}
                            </button>
                          ))}
                        </div>
                      )}
                      <ol className="space-y-4">
                        {passosDoNo.slice(passagem, passagem + 1).map((p) => (
                          <Passo
                            key={p.step_id}
                            passo={p}
                            verDados={exec.pode_ver_dados}
                            ramo={null}
                            abertoInicial
                            configuracao={exec.grafo?.nodes.find((n) => n.id === noId)?.config}
                          />
                        ))}
                      </ol>
                      </>
                    )}
                    {eventosDoNo.length > 0 && (
                      <ul className="border-l border-border pl-3" data-testid="inspetor-eventos">
                        {eventosDoNo.map((e) => {
                          const lido = descreveEvento(e, nosPorId, tagDoIdioma);
                          return (
                            <li key={e.id} className="py-1.5">
                              <p className="text-sm">{t(lido.titulo)}</p>
                              {lido.detalhe && <p className="text-xs text-text-muted">{t(lido.detalhe)}</p>}
                              <p className="text-[11px] text-text-muted">{format(new Date(e.created_at), "dd/MM HH:mm:ss")}</p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <button
                      type="button"
                      className="self-start text-xs text-accent underline-offset-[3px] hover:underline"
                      onClick={() => onSelecionarNo(null)}
                    >
                      {t("Fechar")}
                    </button>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </section>

      <AlertDialog open={confirmaReiniciar} onOpenChange={setConfirmaReiniciar}>
        <AlertDialogContent data-testid="dialogo-reiniciar">
          <AlertDialogHeader>
            <AlertDialogTitle>{recuperar ? t("Recuperar a partir da falha?") : t("Reexecutar do início?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {recuperar
                ? t("Isto cria uma execução vinculada que começa no bloco que falhou, na mesma versão, com as saídas que a original já produziu. Os blocos já concluídos não rodam de novo; só o bloco que falhou roda outra vez. A execução original não muda.")
                : t("Isto cria uma execução nova para o mesmo contato, desde o gatilho, na mesma versão do fluxo. A execução original não muda. Como é uma execução nova, o que o fluxo faz pode acontecer de novo — inclusive mensagens ao cliente.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!recuperar && efeitos.length > 0 && (
            <div className="text-sm" data-testid="reiniciar-efeitos">
              <p className="mb-1 font-medium">{t("Blocos que podem repetir um efeito")}</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {efeitos.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2">
                    <span>{b.rotulo}</span>
                    {b.jaAconteceu && (
                      <Badge variant="warning">{t("já aconteceu na original")}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={rodarPassoAPasso}
              onCheckedChange={setRodarPassoAPasso}
              aria-label={t("Executar passo a passo")}
              data-testid="reiniciar-passo-a-passo"
            />
            <span>
              <span className="font-medium">{t("Executar passo a passo")}</span>
              <span className="block text-xs text-text-muted">
                {t("A reexecução começa pausada e cada bloco só roda quando você mandar.")}
              </span>
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid={recuperar ? "confirmar-recuperar" : "confirmar-reiniciar"}
              onClick={() => {
                if (!exec) return;
                reiniciar.mutate(
                  { id: exec.id, chave: chaveDoReinicio.current, passoAPasso: rodarPassoAPasso, recuperar },
                  { onSuccess: (novo) => onSelecionarExecucao(novo.id) },
                );
                setConfirmaReiniciar(false);
              }}
            >
              {recuperar ? t("Recuperar da falha") : t("Reexecutar do início")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmaCancelar} onOpenChange={setConfirmaCancelar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancelar esta execução?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("O lead não receberá mais mensagens deste fluxo. Essa ação não pode ser desfeita.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (exec) cancelar.mutate(exec.id);
                setConfirmaCancelar(false);
              }}
            >
              {t("Cancelar execução")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
