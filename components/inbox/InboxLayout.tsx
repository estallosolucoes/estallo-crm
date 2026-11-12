"use client";
import "./inbox.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useEstadoDoEnvio } from "@/hooks/inbox/useEstadoDoEnvio";
import { JanelaFechadaAviso } from "@/components/inbox/JanelaFechadaAviso";
import { NumeroForaDoAr } from "@/components/inbox/NumeroForaDoAr";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound, buscarConversa } from "@/hooks/inbox/useConversation";
import { useMutationState, useQueries } from "@tanstack/react-query";
import { CHAVE_DO_ENVIO } from "@/hooks/inbox/useSendMessage";
import type { Retida } from "@/lib/inbox/lista-com-retidas";
import { ConversationList } from "./ConversationList";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { RetentionNotice } from "./RetentionNotice";
import { CRMSidePanel } from "./CRMSidePanel";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";

import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
// ADR-05: ícone de feature sai do mapa canônico, nunca do pacote direto.
import { CaretLeft, ChatCircle, MagnifyingGlass, X } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  LIMITES_FICHA,
  LIMITES_LISTA,
  faixaDaLargura,
  gravarLarguras,
  largurasPadrao,
  lerLarguras,
  moverPorSeta,
  resolverLarguras,
  type Faixa,
  type LargurasDoInbox,
} from "@/lib/inbox/larguras-do-inbox";

/**
 * QUAL COLUNA APARECE NO CELULAR — as duas saem da MESMA pergunta.
 *
 * Abaixo do `md` só cabe uma coluna por vez, então a lista e a conversa se
 * alternam. O defeito que esta função existe para tornar impossível é as duas
 * decidirem por dados DIFERENTES: a lista somia com `selectedId` (o id) e a
 * conversa aparecia com `selectedConversation` (o objeto já carregado). Entre
 * uma coisa e a outra existe uma janela em que nenhuma das duas aparece — e
 * essa janela tem dois casos reais no telefone:
 *
 *   1. o deep-link `/inbox/<id>`, enquanto a busca única ainda responde;
 *   2. a conversa fora do acesso, que é estado PERMANENTE — e cuja mensagem
 *      ("Conversa não encontrada") ficava escondida junto, deixando o dono
 *      numa tela branca sem nem o botão de voltar.
 *
 * Com uma pergunta só, "as duas escondidas" deixa de ser representável.
 * `md:flex` em ambas: no desktop as duas colunas convivem e a regra não vale.
 */
export function colunasDoCelular(temSelecao: boolean): { lista: string; conversa: string } {
  // 851px, e não o `md` (768): é o corte do modelo do Inbox (16/10/2026) — o
  // tablet em pé também vê uma coluna por vez, com a seta de voltar no chat.
  return {
    lista: temSelecao ? "hidden min-[851px]:flex" : "flex",
    conversa: temSelecao ? "flex" : "hidden min-[851px]:flex",
  };
}

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(
  tab: InboxFiltersValue["tab"],
  _automaticoDaOrg?: boolean,
): Partial<ConversationsFilters> {
  switch (tab) {
    case "pending":
      // O cliente escreveu e ninguém respondeu ainda — régua em `lib/inbox/pendentes.ts`.
      return { pendentes: true };
    case "closed":
      // Sem "Arquivar" no Estallo: as arquivadas de antes moram aqui, junto
      // com as fechadas. O badge (`counts`) conta o mesmo par.
      return { status: ["closed", "archived"] };
    case "waiting":
      return { status_chat: "em_espera" };
    case "open":
      return { status_chat: "em_aberto" };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["all", "pending", "waiting", "open", "closed"];

/**
 * Lê ?filter= (G4-02, deep-link); default: Todas. `?filter=mine` é link de antes
 * de "Minhas" virar filtro: abre em Todas com o filtro "Minhas" ligado.
 */
function parseFilterParam(v: string | null): InboxTab {
  if (v === "mine") return "all";
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "all";
}

/**
 * O getter de `window.localStorage` LANÇA (`SecurityError`) quando o navegador
 * bloqueia o armazenamento do site. O `try` de `lerLarguras`/`gravarLarguras`
 * só protege `getItem`/`setItem`; o getter tem de ser lido aqui dentro.
 */
function armazenamentoDoNavegador(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
  /** Rascunho sugerido por integração (issue #1611) — `null` é o caso comum. */
  rascunho?: AvisoDeRascunho | null;
}

export function InboxLayout({ initialSelectedId = null, rascunho = null }: InboxLayoutProps = {}) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const supportReadonly = user.support?.access_mode === "support_readonly";
  const orgId = activeOrg?.orgId ?? null;

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filterNaUrl = searchParams.get("filter");
  const tab = parseFilterParam(filterNaUrl);
  const idNaUrl = searchParams.get("id");
  /**
   * `?tag=` é o destino do link de cada linha do relatório Por etiqueta
   * (#1891): a lista nasce filtrada pelo marcador escolhido lá. Sem esta
   * leitura o link abriria o Inbox SEM filtrar nada — um link que promete
   * conversa e entrega caixa de entrada inteira.
   *
   * Uma etiqueta só: o filtro de VÁRIAS (#1886) é o da própria tela, e uma
   * query repetida aqui não teria como distinguir E de OU no seletor.
   */
  const tagNaUrl = searchParams.get("tag");

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão —
  // exceto a etiqueta, que entra UMA vez, na abertura, pela URL.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
    onlyGroups: false,
    onlyMine: filterNaUrl === "mine",
    ...(tagNaUrl ? { tag: tagNaUrl } : {}),
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        // History API, e não `router.replace`: a página é `force-dynamic`, e o
        // `router.replace` refazia a renderização no SERVIDOR a cada clique de
        // aba (auth + org) — a aba só trocava quando essa ida voltava, e a tela
        // parecia travada. O Next sincroniza `useSearchParams` com o
        // `replaceState` sem pedir nada ao servidor (mesmo caminho da troca de
        // conversa, mais abaixo, com `pushState`).
        window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, pathname],
  );

  // Desliga só os AUXILIARES e mantém a aba: a aba é onde a pessoa está, e
  // limpá-la junto a tiraria do lugar sem ela ter pedido.
  const limparFiltrosAuxiliares = useCallback(() => {
    setFilterValue({ tab, search: "", onlyUnread: false, onlyGroups: false, onlyMine: false });
  }, [tab, setFilterValue]);

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? idNaUrl);
  const ultimoIdNaUrl = useRef(idNaUrl);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  /** A ficha do contato como gaveta — quando a faixa não a comporta como coluna. */
  const [fichaAberta, setFichaAberta] = useState(false);
  /**
   * A ficha como COLUNA, por escolha de quem usa (o botão da ficha no chat).
   * `null` = o padrão da faixa: aberta a partir de 1600px, fechada entre 1280 e
   * 1599 (o modelo do Inbox, 16/10/2026). O CSS pinta o padrão na primeira
   * pintura; a escolha entra como classe por cima.
   */
  const [fichaEscolhida, setFichaEscolhida] = useState<boolean | null>(null);
  /**
   * A busca dentro da conversa (#1793) pertence à CONVERSA em que foi aberta.
   * Guardar o id junto fecha a busca em qualquer troca — clique, atalho j/k,
   * voltar do navegador — sem que cada caminho precise lembrar de limpá-la.
   */
  const [busca, setBusca] = useState<{ conversaId: string; termo: string } | null>(null);
  const buscaAberta = busca !== null && busca.conversaId === selectedId;
  const botaoBuscaRef = useRef<HTMLButtonElement | null>(null);
  const fecharBusca = useCallback(() => {
    setBusca(null);
    botaoBuscaRef.current?.focus();
  }, []);
  /**
   * A mensagem escolhida para responder "em cima".
   *
   * Mora aqui, e não no composer, porque quem ESCOLHE é a lista de mensagens e
   * quem MOSTRA é o composer — são irmãos, e o estado comum é do pai.
   */
  const [respondendo, setRespondendo] = useState<ConversationMensagem | null>(null);
  /**
   * O rascunho sugerido (#1611) vale para a conversa da URL e só enquanto ela
   * está aberta: sair dela — clique, atalho ou voltar do navegador — o descarta
   * de vez. Sem isto o texto escrito para um cliente ficava no campo do próximo,
   * já sem a faixa de origem. Ajuste de estado durante o render, o padrão do
   * React para "estado que depende de outro estado".
   */
  const [rascunhoVivo, setRascunhoVivo] = useState(rascunho);
  if (rascunhoVivo && selectedId !== rascunhoVivo.conversationId) setRascunhoVivo(null);

  useEffect(() => {
    if (ultimoIdNaUrl.current === idNaUrl) return;
    ultimoIdNaUrl.current = idNaUrl;
    // O histórico do navegador também troca a conversa, sem carregar a página inteira.
    setSelectedId(idNaUrl);
    setRespondendo(null);
  }, [idNaUrl]);

  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab),
      // A tela NÃO pede o que a rota recusa: o hook trata falha com
      // `showApiError`, então digitar a primeira letra de qualquer busca faria
      // piscar um erro na cara de quem digita. A regra é a MESMA que o schema
      // usa (`lib/inbox/termo-de-busca.ts`) — nunca repetida aqui.
      search: buscaValeConsulta(filterValue.search) ? filterValue.search : undefined,
      channel_session_id: filterValue.channel_session_id,
      ordem: filterValue.ordem,
      tag: filterValue.tag,
      tagMode: filterValue.tagMode,
      unread: filterValue.onlyUnread || undefined,
      is_group: filterValue.onlyGroups || undefined,
      ...(filterValue.onlyMine ? { assigned_to: "me" } : {}),
    }),
    [
      filterValue.tab,
      filterValue.search,
      filterValue.channel_session_id,
      filterValue.ordem,
      filterValue.tag,
      filterValue.tagMode,
      filterValue.onlyUnread,
      filterValue.onlyGroups,
      filterValue.onlyMine,
    ],
  );

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  //
  // ⚠️ ELA NÃO ESPERA A LISTA — e a espera custava DUAS voltas de rede inteiras.
  //
  // A condição tinha um terceiro termo, `&& !listQ.isLoading`, para poupar uma
  // requisição quando a conversa fosse aparecer na lista de qualquer jeito. O
  // preço real, medido no trace do CI (run 34226618108, deep-link para uma
  // conversa FECHADA — que nenhuma aba da Fila devolve, então a busca única é a
  // única fonte do objeto):
  //
  //   46.725  GET conversations?comando=aguardando               1091ms
  //   48.275  GET conversations?comando=aguardando,automatico     896ms
  //   49.183  GET conversations/<id>                              565ms
  //   49.775  GET contacts/<id>/crm-summary                    (>1034ms)
  //
  // São QUATRO idas em série depois do documento. A lista é pedida duas vezes
  // porque a `queryKey` muda quando `useAutomaticoAtivo` responde (ver
  // `comandosDaFila`), e `isLoading` volta a ser verdadeiro na chave nova — ou
  // seja, o gate segurava a busca única até a SEGUNDA lista assentar, e só
  // então o painel do contato podia começar a carregar. O painel do contato
  // aparecia ~4,7s depois da navegação, e é assim que `encerramento-atendimento`
  // ficou intermitente: a Memória do contato chegava ~0,1–0,6s DEPOIS dos 5s da
  // asserção (o screenshot de falha, tirado logo em seguida, já a mostra).
  //
  // Sem o gate, a busca única sai na primeira leva, em paralelo com a lista, e o
  // objeto existe uma volta depois do documento em vez de três. O custo é UMA
  // requisição extra por deep-link cuja conversa acabe aparecendo na lista —
  // clicar numa conversa da lista já carregada continua sem pedir nada, porque
  // aí `inList` já a tem no primeiro render.
  const needsFetch = !!selectedId && !inList;
  const single = useConversation(selectedId, needsFetch);
  /**
   * O PAINEL NÃO DESMONTA QUANDO A CONVERSA SAI DA LISTA.
   *
   * Responder em "Em espera" (ou receber em "Em aberto") muda o status do chat,
   * e a lista relida deixa de trazê-la. Entre esse instante e a busca única
   * responder, `inList` e `single.data` eram os dois nulos: o painel virava
   * "Selecione uma conversa" e desmontava cabeçalho, fio e composer — piscava,
   * o rascunho digitado se perdia e o canal de mensagens era recriado, perdendo
   * o que chegasse no intervalo (a prévia da lista mostrava a mensagem nova e o
   * fio não). O último objeto conhecido da MESMA conversa segura o painel até a
   * fonte nova responder.
   */
  const vivo = inList ?? single.data ?? null;
  const [ultimaConhecida, setUltimaConhecida] = useState<ConversationWithContact | null>(null);
  if (vivo && vivo !== ultimaConhecida) setUltimaConhecida(vivo);
  const selectedConversation: ConversationWithContact | null =
    vivo ?? (ultimaConhecida?.id === selectedId ? ultimaConhecida : null);

  /**
   * AS CONVERSAS EM QUE O USUÁRIO RESPONDEU FICAM NA LISTA (ver
   * `lib/inbox/lista-com-retidas.ts`). A retenção pertence aos filtros em que
   * nasceu: trocar de aba ou de filtro (ou recarregar) devolve a lista do
   * servidor. O dado da retida vem fresco de `["conversation", id]`.
   */
  const chaveDosFiltros = JSON.stringify(filters);
  const [retencao, setRetencao] = useState<{ chave: string; itens: Retida<ConversationWithContact>[] }>(
    { chave: chaveDosFiltros, itens: [] },
  );
  if (retencao.chave !== chaveDosFiltros) setRetencao({ chave: chaveDosFiltros, itens: [] });
  const envios = useMutationState({
    filters: { mutationKey: CHAVE_DO_ENVIO },
    select: (m) => `${(m.state.variables as { conversation_id?: string } | undefined)?.conversation_id ?? ""}|${m.state.submittedAt}`,
  });
  const ultimoEnvio = envios.at(-1) ?? null;
  const [envioVisto, setEnvioVisto] = useState(ultimoEnvio);
  if (ultimoEnvio !== envioVisto) {
    setEnvioVisto(ultimoEnvio);
    const id = ultimoEnvio?.split("|")[0];
    const lista = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    const indice = lista.findIndex((c) => c.id === id);
    if (id && indice >= 0 && !retencao.itens.some((r) => r.conversa.id === id)) {
      setRetencao({
        chave: chaveDosFiltros,
        itens: [...retencao.itens, { conversa: lista[indice]!, indice }],
      });
    }
  }
  const frescas = useQueries({
    queries: retencao.itens.map((r) => ({
      queryKey: ["conversation", r.conversa.id],
      queryFn: () => buscarConversa(r.conversa.id),
      retry: false,
      enabled: !(listQ.data?.pages.some((p) => p.data.some((c) => c.id === r.conversa.id)) ?? false),
    })),
    // `combine` é memoizado pelo react-query: o array só muda quando um dado muda
    // (sem isso `retidas` nasceria nova a cada render e a lista, que avisa o pai
    // das linhas visíveis por efeito, entraria em laço).
    combine: (resultados) => resultados.map((r) => r.data),
  });
  const retidas = useMemo<Retida<ConversationWithContact>[]>(
    () =>
      retencao.itens.map((r, i) => ({
        indice: r.indice,
        conversa:
          (r.conversa.id === selectedId ? selectedConversation : null) ?? frescas[i] ?? r.conversa,
      })),
    [retencao.itens, selectedId, selectedConversation, frescas],
  );
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const colunas = colunasDoCelular(Boolean(selectedId));

  const claim = useClaimConversation();
  const close = useCloseConversation();

  // A leitura da conversa aberta é do upstream e fica: sem ela o contador de
  // não-lidas nunca zera para quem abre a conversa.
  useMarkAsRead(
    selectedConversation?.id ?? null,
    selectedConversation?.unread_count_for_assignee ?? 0,
  );

  // Aceita `null`: é o VOLTAR do celular, que limpa a seleção e devolve a lista.
  // É um SUPERCONJUNTO do `handleSelect` do upstream — o tipo dele não aceita
  // `null`, e sem isso o botão de voltar não teria o que chamar.
  //
  const handleSelect = useCallback(
    (id: string | null) => {
    if (id === selectedId) return;
    setSelectedId(id);
    // Sem isto, escolher "responder" numa conversa e trocar para outra levaria
    // a citação junto — e a resposta sairia citando mensagem de outro cliente.
    setRespondendo(null);
    // ?id= é o formato já usado pelos atalhos do CRM. A History API mantém a
    // seleção instantânea sem pedir um novo Server Component a cada clique.
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("id", id);
    else params.delete("id");
    // O ?rascunho= é da conversa que ficou para trás (ver `rascunhoVivo`).
    params.delete("rascunho");
    const query = params.toString();
    window.history.pushState(null, "", query ? `${pathname}?${query}` : pathname);
    },
    [selectedId, searchParams, pathname],
  );
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  // Janela de 24h, contato bloqueado e suporte só-leitura: a MESMA regra do
  // chat suspenso (`hooks/inbox/useEstadoDoEnvio.ts`).
  const { motivoDaJanela, blockedReason } = useEstadoDoEnvio(selectedConversation);

  /* ─── DIVISÓRIAS ARRASTÁVEIS (#2579) ────────────────────────────────────
   *
   * A largura das colunas nasceu fixa no CSS (linha do `grid-cols` abaixo) e
   * era a única reclamação de quem usava o Inbox num monitor grande: conversa
   * gigante, lista e ficha cortadas, sem como ajustar. Aqui o CSS continua
   * sendo o PADRÃO — quem nunca arrastou vê exatamente a mesma grade de antes,
   * pintada pelo servidor, sem esperar JavaScript — e a largura ajustada entra
   * por cima como `gridTemplateColumns` inline, só depois da montagem.
   *
   * A regra (limites 240–520 / 260–560, piso de conversa de 420, memória por
   * faixa, teclado) mora em `lib/inbox/larguras-do-inbox.ts`, não aqui: este
   * arquivo posiciona a alça e chama a função; aquilo é o que o teste prende.
   *
   * `faixa` é `null` até o efeito rodar (e sempre, no servidor e abaixo do
   * `md`) — é o que garante primeiro render idêntico ao do servidor: sem
   * divisória nenhuma e sem estilo nenhum na grade. No celular nada muda.
   */
  const gradeRef = useRef<HTMLDivElement | null>(null);
  const [faixa, setFaixa] = useState<Faixa | null>(null);
  const [larguras, setLarguras] = useState<LargurasDoInbox | null>(null);
  // Espelho do estado para o fim do arraste (pointerup) persistir o valor mais
  // recente sem depender de um render que ainda não aconteceu.
  const largurasRef = useRef<LargurasDoInbox | null>(null);

  const aplicarLarguras = useCallback((proximas: LargurasDoInbox | null) => {
    largurasRef.current = proximas;
    setLarguras(proximas);
  }, []);

  useEffect(() => {
    const medir = () => setFaixa(faixaDaLargura(window.innerWidth));
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, []);

  // Trocar de faixa (ou montar) retoma a largura SALVA DAQUELA faixa e já a
  // resolve contra a largura real da grade: a mesma chave `xl` cobre 1280–1535
  // e o piso da conversa tem de caber nos dois extremos. Sem nada salvo,
  // `null` = padrão do CSS, e a grade nem fica sabendo disto.
  useEffect(() => {
    if (!faixa) {
      aplicarLarguras(null);
      return;
    }
    const grade = gradeRef.current;
    const largura = grade ? grade.getBoundingClientRect().width : 0;
    const salvas = lerLarguras(armazenamentoDoNavegador(), faixa.id);
    aplicarLarguras(
      salvas
        ? resolverLarguras({ ...salvas, larguraContainer: largura, temFicha: faixa.temFicha })
        : null,
    );
  }, [faixa, aplicarLarguras]);

  /** O que vale AGORA na tela: o ajuste salvo, ou o padrão da faixa. */
  const efetivas: LargurasDoInbox | null = larguras ?? (faixa ? largurasPadrao(faixa) : null);
  /** A ficha está de pé como COLUNA agora (a faixa comporta e quem usa quer). */
  const fichaNaColuna = Boolean(faixa?.temFicha) && (fichaEscolhida ?? faixa?.id === "2xl");
  const alternarFicha = useCallback(() => {
    if (faixa?.temFicha) setFichaEscolhida(!fichaNaColuna);
    else setFichaAberta((aberta) => !aberta);
  }, [faixa, fichaNaColuna]);

  const estiloDaGrade: CSSProperties | undefined =
    faixa && larguras
      ? {
          gridTemplateColumns: fichaNaColuna
            ? `${larguras.lista}px minmax(0,1fr) ${larguras.ficha}px`
            : `${larguras.lista}px minmax(0,1fr)`,
        }
      : undefined;

  const larguraDaGrade = (): number => {
    const grade = gradeRef.current;
    return grade ? grade.getBoundingClientRect().width : 0;
  };

  const arrastar = (coluna: "lista" | "ficha", evento: ReactPointerEvent<HTMLSpanElement>) => {
    if (evento.button !== 0 || !faixa || !efetivas) return;
    const grade = gradeRef.current;
    if (!grade) return;
    // A medida é uma SÓ, lida no início do arraste: a grade não muda de
    // tamanho enquanto o ponteiro anda, e remediá-la a cada move faria o
    // alvo tremer contra o próprio valor que o usuário está arrastando.
    const retangulo = grade.getBoundingClientRect();
    evento.preventDefault();
    evento.stopPropagation();
    evento.currentTarget.setPointerCapture?.(evento.pointerId);
    const base = largurasRef.current ?? efetivas;
    const temFicha = fichaNaColuna;
    const faixaAtual = faixa;

    const aoMover = (movimento: PointerEvent) => {
      const pedido =
        coluna === "lista"
          ? { ...base, lista: movimento.clientX - retangulo.left }
          : { ...base, ficha: retangulo.right - movimento.clientX };
      aplicarLarguras(resolverLarguras({ ...pedido, larguraContainer: retangulo.width, temFicha }));
    };
    const aoSoltar = () => {
      window.removeEventListener("pointermove", aoMover);
      window.removeEventListener("pointerup", aoSoltar);
      gravarLarguras(armazenamentoDoNavegador(), faixaAtual.id, largurasRef.current);
    };
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
  };

  const teclarNaDivisoria = (
    coluna: "lista" | "ficha",
    evento: ReactKeyboardEvent<HTMLSpanElement>,
  ) => {
    if (!faixa || !efetivas) return;
    const proximo = moverPorSeta(coluna, (largurasRef.current ?? efetivas)[coluna], evento.key);
    if (proximo === null) return;
    evento.preventDefault();
    const base = { ...(largurasRef.current ?? efetivas), [coluna]: proximo };
    aplicarLarguras(
      resolverLarguras({ ...base, larguraContainer: larguraDaGrade(), temFicha: fichaNaColuna }),
    );
    gravarLarguras(armazenamentoDoNavegador(), faixa.id, largurasRef.current);
  };

  /** Duplo clique na divisória: apaga a memória da faixa e volta ao CSS. */
  const restaurarPadrao = useCallback(() => {
    if (!faixa) return;
    gravarLarguras(armazenamentoDoNavegador(), faixa.id, null);
    aplicarLarguras(null);
  }, [faixa, aplicarLarguras]);

  // Altura da grade: a conta desconta TUDO que fica acima e abaixo dela.
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //   2 * --space-6     padding do <main> do AppShell (`p-6`, em cima e embaixo)
  //
  // Com `100vh-3.5rem` o padding ficava de fora e a grade media 48px a MAIS que a
  // tela. Quem pagava a diferença era o composer, que fica no rodapé: nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // As duas parcelas NÃO estão na mesma unidade, e por isso o padding entra pelo
  // token e não como `3rem`: o `@theme inline` de `app/globals.css` remapeia a
  // escala de spacing para `var(--space-N)` — `--space-6` é `24px` LITERAL —, mas
  // não remapeia o `14`, que o Tailwind 4 calcula pelo multiplicador `--spacing`
  // e segue sendo `3.5rem` de verdade. (Até o Tailwind 4 quem remapeava era o
  // `tailwind.config.ts`; o arquivo não existe mais, o efeito é o mesmo.)
  // Escrever a soma como
  // `6.5rem` só acerta enquanto a raiz for 16px; com acessibilidade de fonte maior
  // ou menor o composer sai da tela de novo. Pelo token, a conta se auto-corrige
  // se a escala de espaçamento mudar.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.

  // TRÊS COLUNAS QUE CABEM — medido, não estimado.
  //
  // O `xl` do Tailwind dispara em 1280px, e era ali que a terceira coluna
  // nascia: no ponto exato em que não havia espaço para ela. Com a barra de
  // navegação (240px) sobram 1040px, e o grid pedia 300 + 707 + 320 = 1327 —
  // o painel de CRM ficava 311px FORA da viewport, alcançável só rolando o
  // `main` de lado, que ninguém faz. Em 1280 o atendente simplesmente não via
  // contexto nenhum do cliente.
  //
  // Os 707px eram o `min-content` do `ConversationHeader` (a barra de ações
  // era `shrink-0`), e `1fr` é `minmax(auto, 1fr)`: não encolhe abaixo disso.
  // Consertado o header, o `1fr` volta a encolher sozinho — `minmax(0,1fr)`
  // foi medido aqui e não mudou um pixel, então não entrou.
  //
  // Duas faixas em vez de uma: compacta onde aperta, generosa onde há espaço.
  // Em 1280 isso dá 424px de conversa em vez de 372 — 54px de folga sobre o
  // piso do composer (370px), em vez dos 2px que a versão de uma faixa só
  // deixava. Margem de 2px não é margem, é sorte.
  return (
    <OpenConversationProvider conversationId={selectedId}>
    <div
      ref={gradeRef}
      className={cn(
        "ibx ibx-grade relative h-[calc(100dvh-3.5rem-var(--space-6)-max(var(--space-6),var(--rodape-ocupado,0px)))] w-full",
        fichaEscolhida === true && "ibx-ficha-aberta",
        fichaEscolhida === false && "ibx-ficha-fechada",
      )}
      style={estiloDaGrade}
      /*
       * O ESTADO DO TEMPO REAL, LEGÍVEL DE FORA — mesmo par que o dossiê do lead
       * já publica (`LeadDossier`), e pela mesma razão: quando a entrega morre,
       * nenhuma tela avisa. Foi o único achado que atravessou o dia intacto
       * quando o realtime quebrou pela primeira vez, e voltou a morder agora.
       *
       * `divergencias` é o que a rede de segurança contou: refetch trouxe estado
       * novo que o canal NÃO tinha entregue. Zero com o canal vivo; subindo é a
       * assinatura de canal que assina e não entrega — o defeito que não grita.
       *
       * ⚠️ `data-realtime-status` vem do STATUS do canal, não de um objeto que
       * existe sempre. A primeira versão desta linha derivava o valor de
       * `listQ.seguranca`, que nunca é nulo — ela diria `ativo` inclusive com o
       * canal morto. Controle decorativo é pior que controle nenhum: mente com
       * cara de instrumento.
       *
       * Atributo de dado e não texto na tela de propósito: quem lê isto é o
       * teste e quem depura, não o atendente. Pôr um aviso permanente na cara de
       * quem atende seria ruído; esconder o sinal do todo é o que custou o dia.
       */
      data-realtime-status={listQ.realtimeStatus}
      data-refetch-divergencias={listQ.seguranca?.divergencias ?? 0}
    >
      {/*
        NO CELULAR, UMA COISA POR VEZ.

        Antes as duas colunas caíam empilhadas em `grid-cols-1`: a lista inteira
        primeiro e a conversa DEPOIS dela. Para responder era preciso rolar a
        lista toda até o fim, e o composer ficava fora da tela — que é o
        "incômodo" relatado por quem atende do telefone.

        Sem media query em JavaScript de propósito: `useMediaQuery` decide DEPOIS
        da hidratação, então a primeira pintura mostra o layout errado e pisca. A
        classe condicional é resolvida pelo CSS, na primeira pintura, e some no
        `md` — onde as duas colunas cabem juntas e a regra não se aplica.
      */}
      <div className={cn("ibx-list-panel h-full min-h-0 flex-col", colunas.lista)}>
        <InboxFilters
          value={filterValue}
          onChange={setFilterValue}
          onAbrirAtalhos={() => setHelpOpen(true)}
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            listQuery={listQ}
            retidas={retidas}
            filters={filters}
            selectedId={selectedId}
            onSelect={handleSelect}
            onVisibleChange={handleVisibleChange}
            onLimparFiltros={limparFiltrosAuxiliares}
            onFecharConversa={() => handleSelect(null)}
          />
        </div>
        {/* O rodapé do modelo, dizendo a VERDADE: o ponto acompanha o estado
            do canal de tempo real (o mesmo `data-realtime-status` da grade). */}
        <div className="ibx-list-footer">
          <span
            className="ibx-live-dot"
            data-status={listQ.realtimeStatus === "subscribed" ? "on" : "off"}
            aria-hidden
          />
          {listQ.realtimeStatus === "subscribed"
            ? t("Atualização em tempo real")
            : listQ.realtimeStatus === "connecting"
              ? t("Conectando o tempo real…")
              : t("Reconectando o tempo real…")}
        </div>
      </div>

      {/*
        AS DUAS COLUNAS DECIDEM PELO MESMO DADO — `selectedId`, não o objeto.

        A da lista some quando há `selectedId`; se esta aparecesse só quando a
        conversa já está CARREGADA, a janela entre as duas coisas não mostra
        nenhuma das colunas. No celular isso é a tela em branco, e ela tem dois
        casos reais: o instante do deep-link `/inbox/<id>`, enquanto a busca
        única ainda responde; e o estado permanente de conversa fora do acesso,
        cuja mensagem ("Conversa não encontrada") é justamente o que ficava
        escondido — deixando o dono numa tela vazia, sem sequer o botão de
        voltar, porque ele morava dentro do ramo da conversa carregada.
      */}
      <div className={cn("ibx-chat h-full min-h-0 min-w-0 flex-col", colunas.conversa)}>
        {/*
          A barra do celular vive FORA do ramo da conversa carregada: o caminho
          de volta tem de existir inclusive quando não há o que mostrar — é aí
          que ele é a única saída. A porta da ficha, essa sim, depende da
          conversa, e só aparece quando há uma.
        */}
        {/* Sem a conversa carregada (deep-link respondendo, ou fora do acesso)
            o cabeçalho do chat não existe — e a seta de voltar mora nele. Esta
            barra é o caminho de volta nesse intervalo, só onde há uma coluna. */}
        {selectedId && !selectedConversation && (
          <div className="flex items-center gap-1 border-b border-border px-1 py-1 min-[851px]:hidden">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1 px-2"
              onClick={() => handleSelect(null)}
            >
              <CaretLeft size={16} />
              {t("Conversas")}
            </Button>
          </div>
        )}
        {/* A ficha como GAVETA: abaixo de 1280px (onde ela não vira coluna),
            aberta pelo botão da ficha no cabeçalho do chat. */}
        {selectedConversation && (
          <Sheet open={fichaAberta && !fichaNaColuna} onOpenChange={setFichaAberta}>
            <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto p-0">
              <SheetTitle className="sr-only">{t("Ficha do contato")}</SheetTitle>
              <CRMSidePanel conversation={selectedConversation} />
            </SheetContent>
          </Sheet>
        )}
        {selectedConversation ? (
          <>
            {/* `key`: trocar de conversa desmonta a confirmação de Fechar/Arquivar
                aberta — senão o clique de dentro agiria sobre a conversa nova. */}
            <ConversationHeader
              key={selectedConversation.id}
              conversation={selectedConversation}
              onAbrirConversa={handleSelect}
              onBuscar={() =>
                buscaAberta
                  ? fecharBusca()
                  : setBusca({ conversaId: selectedConversation.id, termo: "" })
              }
              buscaAberta={buscaAberta}
              botaoBuscaRef={botaoBuscaRef}
              fichaVisivel={fichaNaColuna || fichaAberta}
              onAlternarFicha={alternarFicha}
              onVoltar={() => handleSelect(null)}
            />
            {buscaAberta && (
              <div className="ibx-message-search-bar">
                  <MagnifyingGlass
                    size={16}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                <input
                  type="search"
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-hidden placeholder:text-muted-foreground"
                  aria-label={t("Buscar nas mensagens carregadas")}
                  placeholder={t("Buscar nas mensagens carregadas")}
                  value={busca.termo}
                    onChange={(e) =>
                      setBusca({ conversaId: busca.conversaId, termo: e.target.value })
                    }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") fecharBusca();
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-11 shrink-0 px-0 lg:w-8"
                  aria-label={t("Fechar busca")}
                  onClick={fecharBusca}
                >
                  <X size={16} aria-hidden />
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread
                conversationId={selectedConversation.id}
                searchTerm={buscaAberta ? busca.termo : ""}
                provider={selectedConversation.channel_sessions?.provider ?? null}
                onResponder={setRespondendo}
                // O cartão da passagem escolhe o gesto a partir de quem é o dono
                // da conversa: sem dono convida a assumir, com outro dono diz
                // quem atende. Sem estes dois campos ele cairia no estado mais
                // conservador e ficaria mudo justamente para quem mais precisa.
                dono={{
                  userId: selectedConversation.assigned_to_user_id ?? null,
                  nome: selectedConversation.assigned_to_user_name ?? null,
                }}
                contatoId={selectedConversation.contacts?.id ?? null}
              />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            {selectedConversation.contacts?.id && (
              <NumeroForaDoAr
                key={`numero:${selectedConversation.id}`}
                conversationId={selectedConversation.id}
                channelSessionId={selectedConversation.channel_session_id}
                contactId={selectedConversation.contacts.id}
                contactPhone={selectedConversation.contacts.phone_number ?? null}
                onAbrirConversa={handleSelect}
              />
            )}
            {motivoDaJanela && (
              <JanelaFechadaAviso
                conversationId={selectedConversation.id}
                provider={selectedConversation.channel_sessions?.provider ?? null}
                motivo={motivoDaJanela}
              />
            )}
            <Composer
              // Trocar a chave quando o rascunho sai REMONTA o composer: o texto
              // nasce de `useState(initialDraft)`, e só a prop mudar não o limparia.
              // Sem rascunho a chave é fixa e a troca de conversa segue como antes.
              key={rascunhoVivo ? `rascunho:${rascunhoVivo.conversationId}` : "composer"}
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={blockedReason}
              janelaFechada={motivoDaJanela}
              contactName={selectedConversation.contacts?.name ?? null}
              contactDisplayName={selectedConversation.contacts?.display_name}
              respondendo={respondendo}
              onCancelarResposta={() => setRespondendo(null)}
              currentContactId={selectedConversation.contact_id}
              // O aviso é DA conversa da URL: trocar de conversa dentro da inbox
              // não pode deixar um texto sugerido no campo de outra pessoa.
              rascunho={rascunhoVivo}
              initialDraft={
                rascunhoVivo?.leitura.estado === "sugerido" ? rascunhoVivo.leitura.texto : ""
              }
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("Conversa não encontrada ou fora do seu acesso.")}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ChatCircle size={36} weight="thin" className="text-text-subtle" aria-hidden />
            <p className="text-sm font-medium text-text-muted">{t("Selecione uma conversa")}</p>
            <p className="text-xs text-text-muted">{t("Ou navegue com J e K")}</p>
          </div>
        )}
      </div>

      <div className="ibx-coluna-ficha h-full min-h-0 min-w-0">
        <CRMSidePanel conversation={selectedConversation} />
      </div>

      {/*
        AS DUAS DIVISÓRIAS (#2579) — só a partir do `md`, quando as colunas
        convivem; abaixo disso `efetivas` é `null` e nenhuma nasce.

        `absolute` de propósito: a alça não é um item da grade (não ocupa
        trilha), ela se apoia em cima da borda entre as duas — por isso a
        grade precisa do `relative`. A da lista anda pela ESQUERDA (o valor é
        a largura da lista); a da ficha pela DIREITA (o valor é a largura da
        ficha), o que evita medir a conversa para saber onde a terceira trilha
        começa.
      */}
      {efetivas && (
        <>
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={t("Ajustar largura da lista de conversas")}
            title={t("Arraste para ajustar a largura")}
            aria-valuenow={efetivas.lista}
            aria-valuemin={LIMITES_LISTA.min}
            aria-valuemax={LIMITES_LISTA.max}
            data-divisoria="lista"
            tabIndex={0}
            onPointerDown={(evento) => arrastar("lista", evento)}
            onDoubleClick={restaurarPadrao}
            onKeyDown={(evento) => teclarNaDivisoria("lista", evento)}
              className="group absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center select-none focus-visible:outline-hidden"
            style={{ left: `${efetivas.lista}px` }}
          >
            <span
              aria-hidden
              className="w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
            />
          </span>
          {fichaNaColuna && (
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={t("Ajustar largura da ficha do contato")}
              title={t("Arraste para ajustar a largura")}
              aria-valuenow={efetivas.ficha}
              aria-valuemin={LIMITES_FICHA.min}
              aria-valuemax={LIMITES_FICHA.max}
              data-divisoria="ficha"
              tabIndex={0}
              onPointerDown={(evento) => arrastar("ficha", evento)}
              onDoubleClick={restaurarPadrao}
              onKeyDown={(evento) => teclarNaDivisoria("ficha", evento)}
                className="group absolute inset-y-0 z-10 flex w-2 translate-x-1/2 cursor-col-resize touch-none items-stretch justify-center select-none focus-visible:outline-hidden"
              style={{ right: `${efetivas.ficha}px` }}
            >
              <span
                aria-hidden
                className="w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
              />
            </span>
          )}
        </>
      )}

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={supportReadonly ? () => {} : handleClaim}
        onClose={supportReadonly ? () => {} : handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
    </OpenConversationProvider>
  );
}
