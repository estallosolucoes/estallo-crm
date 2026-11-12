"use client";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EnvelopeSimple,
  FadersHorizontal,
  Inbox,
  Info,
  Keyboard,
  MagnifyingGlass,
  User,
  UsersThree,
  X,
} from "@/lib/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { type ModoDeEtiqueta, marcadoresEscolhidos } from "@/lib/inbox/marcador-da-conversa";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import type { Role, VisibilityMode } from "@/lib/auth/types";

export type InboxTab = "all" | "pending" | "waiting" | "open" | "closed";

/** Categorias do atendimento, na ordem de leitura da operação. */
const INBOX_TABS: { value: InboxTab; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "pending", label: "Sem resposta" },
  { value: "waiting", label: "Em espera" },
  { value: "open", label: "Em aberto" },
  { value: "closed", label: "Fechadas" },
];

/**
 * Visões visíveis por papel + escopo (G4-02). Todas as abas para todo papel:
 * "Todas" ficava oculta para `agent` em visibility_mode ≠ 'all' porque ele
 * tinha a aba "Minhas"; agora "Minhas" é filtro e "Todas" + "Minhas" é a
 * caixa dele. Esconder nunca foi segurança — a RLS (G4-01) recorta o escopo.
 */
export function visibleInboxTabs(_role: Role, _mode: VisibilityMode | undefined): InboxTab[] {
  return INBOX_TABS.map((t) => t.value);
}

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
  ordem?: "antigo" | "recente";
  /**
   * A etiqueta escolhida, ou VÁRIAS (#1274).
   *
   * `string` continua aceito e continua significando a MESMA coisa: é o que o
   * `InboxLayout`, o deep-link e qualquer chamada antiga produzem. Uma etiqueta
   * só nunca tem dois sentidos, porque o caminho singular da régua
   * (`aplicarMarcador`) é o mesmo de antes — byte a byte.
   */
  tag?: string | readonly string[];
  /** E ou OU entre as etiquetas escolhidas (#1274). `e` é o padrão. */
  tagMode?: ModoDeEtiqueta;
  /** A aba "Grupos" (Task 10): manda `is_group=true` na listagem. */
  onlyGroups?: boolean;
  /** "Minhas": só as atribuídas a mim, em qualquer aba (`assigned_to=me`). */
  onlyMine?: boolean;
}

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
  /** Abre a ajuda de atalhos (o botão de teclado ao lado de "Inbox"). */
  onAbrirAtalhos?: () => void;
}

/** O rascunho do popover "Filtrar conversas": só vale no "Aplicar filtros". */
interface RascunhoDosFiltros {
  onlyMine: boolean;
  onlyUnread: boolean;
  onlyGroups: boolean;
  channel_session_id?: string;
  ordem?: "antigo" | "recente";
  tags: string[];
  tagMode?: ModoDeEtiqueta;
}

export function InboxFilters({ value, onChange, onAbrirAtalhos }: Props) {
  const t = useT();
  const [ajudaAberta, setAjudaAberta] = useState(false);
  const [searchInput, setSearchInput] = useState(value.search);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [moreTabs, setMoreTabs] = useState({ left: false, right: false });
  const updateMoreTabs = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
    const next = { left: list.scrollLeft > 1, right: list.scrollLeft < maxScroll - 1 };
    setMoreTabs((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next,
    );
  }, []);
  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const centerSelectedTab = () => {
      // Deixar a aba só na borda esconde as vizinhas. Centralizar mostra o
      // contexto dos dois lados, salvo nas extremidades naturais da faixa.
      const selected = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (selected) {
        const selectedCenter =
          selected.getBoundingClientRect().left -
          list.getBoundingClientRect().left +
          list.scrollLeft +
          selected.offsetWidth / 2;
        const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
        list.scrollLeft = Math.max(0, Math.min(maxScroll, selectedCenter - list.clientWidth / 2));
      }
      updateMoreTabs();
    };
    centerSelectedTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(centerSelectedTab);
    observer.observe(list);
    list.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [value.tab, updateMoreTabs]);
  /**
   * O campo escuta o valor de FORA — e só ele.
   *
   * O estado do campo é próprio porque o debounce mora nele. O preço era não
   * saber quando o filtro morria por outro caminho: "Limpar filtros" zerava a
   * busca aplicada e deixava o termo escrito na tela, mostrando uma busca que
   * não valia mais — a mesma mentira de tela que esta entrega existe para matar.
   *
   * A ref guarda o que ESTE campo propagou. Valor de fora diferente dela = a
   * mudança veio de outro lugar, e o campo adota. Igual = foi o próprio campo, e
   * adotar atropelaria quem continuou digitando.
   *
   * ⚠️ O QUE O TESTE ALCANÇA, E O QUE NÃO. Tirar este efeito reprova o primeiro
   * caso de `tests/unit/limpar-filtros-limpa-o-campo.test.tsx` — medido. Já a
   * marca lá embaixo, no timer, NÃO é alcançada por teste determinístico: ela
   * defende a corrida entre o timer disparar e este efeito rodar, e nessa fresta
   * o teste nunca consegue digitar. Medido também: sabotá-la deixa os dois casos
   * verdes. Está escrito aqui em vez de fingir cobertura que não existe.
   */
  const propagado = useRef(value.search);
  useEffect(() => {
    if (value.search !== propagado.current) {
      propagado.current = value.search;
      setSearchInput(value.search);
    }
  }, [value.search]);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  const { activeOrg } = useAuth();
  /**
   * As opções são a UNIÃO das duas caixas — as mesmas que o filtro consulta
   * (`conversations.tags` ou `contacts.tags`, no handler da lista).
   *
   * Vinham só do vocabulário de CONVERSA: o marcador escrito no contato nem
   * aparecia para ser escolhido. Quem oferece e quem filtra lendo fontes
   * diferentes é o defeito espelhado — ou a opção existe e devolve vazio, ou o
   * marcador que funciona nunca é oferecido.
   */
  const orgId = activeOrg?.orgId ?? null;
  // Estallo (0659): conversa não tem mais etiqueta — o filtro é pela do contato.
  const { data: tagsDeContato } = useContactTagVocabulary(orgId);
  const tagVocabulary = useMemo(
    () =>
      tagsDeContato == null ? undefined : [...tagsDeContato].sort((a, b) => a.localeCompare(b)),
    [tagsDeContato],
  );
  // A lista de etiquetas escolhida, normalizada pelo MESMO caminho do servidor
  // (`marcadoresEscolhidos`): sem vazio, sem repetido, com a ordem da primeira
  // aparição. Duas fontes de verdade para "quantas etiquetas estão escolhidas"
  // fariam a tela mostrar um filtro e a lista aplicar outro.
  const etiquetas = useMemo(
    () => marcadoresEscolhidos(typeof value.tag === "string" ? [value.tag] : (value.tag ?? [])),
    [value.tag],
  );
  // Os MESMOS filtros que a lista aplicou. Badge que conta o que a aba não mostra
  // manda o atendente procurar trabalho que não existe — a regra já estava escrita
  // na rota; faltava alcançar os filtros ao lado da aba.
  const { data: counts } = useConversationCounts(activeOrg?.orgId ?? null, {
    unread: value.onlyUnread,
    tag: etiquetas,
    tagMode: value.tagMode,
    channel_session_id: value.channel_session_id,
    soMinhas: value.onlyMine,
  });

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((t) => t.value);
  const moveTab = (direction: -1 | 1) => {
    const next = tabs[tabs.indexOf(value.tab) + direction];
    if (next) onChange({ ...value, tab: next });
  };
  const countFor: Partial<Record<InboxTab, number>> = {
    waiting: counts?.em_espera,
    open: counts?.em_aberto,
    pending: counts?.pendentes,
    all: counts?.all,
    closed: counts?.closed,
  };
  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox mostrando um subconjunto — às vezes vazio — sem nada na
  // tela dizendo que há filtro. O número some do dropdown junto com o canal, e o
  // alternador inteiro sumiria com ele se sobrasse menos de dois.
  const filtroForaDaLista =
    value.channel_session_id != null &&
    channels != null &&
    !channels.some((c) => c.id === value.channel_session_id);
  // O canal fica disponível mesmo com uma única instância.
  const showChannelSwitch = true;
  /**
   * O SELETOR NÃO PODE SUMIR DEBAIXO DO MENU ABERTO.
   *
   * A condicional abaixo decide a EXISTÊNCIA do `<Select>`, e ela lê duas
   * queries em voo — as duas com `orgId` na chave e `enabled: !!orgId`. Um
   * único render em que o vocabulário volte a indefinido ou vazio (chave nova,
   * refetch, organização piscando) não escondia só o controle: DESMONTAVA o
   * Select, e o menu que o operador tinha acabado de abrir fechava sozinho, com
   * o gatilho de volta em "Todas as tags". Era o filtro fechando na cara de
   * quem ia escolher, e o `filtro-por-marcador-pela-tela.spec.ts` intermitente.
   *
   * Por isso o seletor passa a usar o último vocabulário NÃO-VAZIO que esta
   * tela conheceu: enquanto o de agora oscila, o de antes segura o controle
   * montado. O quadro nunca teve o defeito pelo mesmo motivo por outro caminho
   * — `components/kanban/FilterBar.tsx` mantém o gatilho montado e só o desliga
   * (`disabled`) sem opções. A lembrança faz o mesmo serviço sem estrear um
   * controle morto para a organização que ainda não tem etiqueta nenhuma: essa
   * continua sem o seletor, que é o que a condicional sempre quis dizer.
   *
   * Medido em `tests/unit/inbox-filtro-de-tag-nao-desmonta.test.tsx`.
   */
  const [ultimoVocabulario, setUltimoVocabulario] = useState<string[]>([]);
  if (tagVocabulary != null && tagVocabulary.length > 0 && tagVocabulary !== ultimoVocabulario) {
    // Ajuste de estado DURANTE a renderização (o padrão que a documentação do
    // React chama de "adjusting state when props change"): o React reinicia o
    // render deste componente com o valor novo antes de pintar, então o seletor
    // nunca chega à tela com o vocabulário velho. Efeito aqui não serviria —
    // ele roda DEPOIS da pintura, e a janela de um frame é exatamente a que
    // desmonta o Select.
    setUltimoVocabulario(tagVocabulary);
  }
  const vocabularioDoSeletor =
    tagVocabulary != null && tagVocabulary.length > 0 ? tagVocabulary : ultimoVocabulario;
  // O MESMO tratamento, agora para a etiqueta. Sem ele, o seletor inteiro some
  // com o filtro AINDA APLICADO — a lista fica num subconjunto, às vezes vazio,
  // e nada na tela diz que há filtro nem oferece como tirá-lo.
  // "Conhecido" e "não-vazio" são coisas diferentes, e é o primeiro que vale
  // aqui: a organização cuja ÚLTIMA etiqueta acabou de ser apagada responde
  // vocabulário vazio, e é justamente ela que precisa do seletor de volta para
  // desfazer o filtro que continua valendo.
  const vocabularioConhecido = tagVocabulary != null || ultimoVocabulario.length > 0;
  // ⚠️ A VALIDAÇÃO DO FILTRO ÓRFÃO PASSOU A SER SOBRE A LISTA (#1274). Com uma
  // etiqueta só, "está no vocabulário" é uma pergunta; com VÁRIAS, é outra: basta
  // uma das escolhidas ter sumido do vocabulário para o operador precisar da
  // válvula. O sintoma sem isto seria o pior dos dois: um filtro de duas
  // etiquetas, uma delas apagada, e a tela sem dizer que há filtro nenhum.
  // ⚠️ `&&` AQUI DEVOLVERIA `false | string[]`, e `false.length` não existe. A
  // forma é um ternário que devolve SEMPRE lista: o resto do componente só
  // precisa do comprimento, e um `false` no meio obrigaria cada uso a checar.
  const etiquetasForaDoVocabulario =
    etiquetas.length > 0 && vocabularioConhecido
      ? etiquetas.filter((tag) => !vocabularioDoSeletor.includes(tag))
      : [];
  const mostrarSeletorDeTag =
    vocabularioDoSeletor.length > 0 || etiquetasForaDoVocabulario.length > 0;
  // O menu não fecha a cada clique: quem escolhe duas etiquetas não pode ter de
  // reabrir o menu entre a primeira e a segunda, e o `DropdownMenuCheckboxItem`
  // é o item que NÃO fecha (o `Select` de hoje fecha). A regra é do componente,
  // e por isso o gatilho é um botão com `aria-expanded` em vez de um `Select`.
  const opcoesDoSeletor = [...vocabularioDoSeletor, ...etiquetasForaDoVocabulario];
  /**
   * A BUSCA DENTRO DO SELETOR (#2498) — e ela é de propósito SEM consulta.
   *
   * O vocabulário inteiro já está no navegador (as mesmas duas caixas que o
   * filtro consulta), então filtrar aqui custa um `filter` em memória. O que a
   * busca NÃO pode fazer é mexer em `value`: `tag`/`tagMode` são a CHAVE da
   * query de contagens e do pedido da lista, e cada tecla que os alterasse
   * mandaria uma ida ao servidor por caractere digitado — o oposto do que a
   * issue pede.
   *
   * O estado mora aqui e é ZERADO ao fechar o menu (`onOpenChange`): um termo
   * esquecido reabriria o seletor já filtrado, sem dizer que há filtro — a
   * mesma tela que mente que esta entrega existe para matar.
   */
  const [buscaDeEtiqueta, setBuscaDeEtiqueta] = useState("");
  const termoDaEtiqueta = buscaDeEtiqueta.trim().toLocaleLowerCase();
  const opcoesVisiveis = termoDaEtiqueta
    ? opcoesDoSeletor.filter((tag) => tag.toLocaleLowerCase().includes(termoDaEtiqueta))
    : opcoesDoSeletor;
  const alternaEtiqueta = (tag: string) => {
    const escolhida = etiquetas.includes(tag);
    const proximas = escolhida ? etiquetas.filter((t) => t !== tag) : [...etiquetas, tag];
    onChange({
      ...value,
      tag: proximas.length === 0 ? undefined : proximas,
      // O `modo` só faz sentido com DUAS: ao voltar para uma etiqueta só, ele
      // sai, porque `?tag=vip&modo=ou` é um link que não significa nada e
      // polui a URL (e a chave de cache do react-query) à toa.
      tagMode: proximas.length > 1 ? value.tagMode : undefined,
    });
  };

  // O timer lê o valor MAIS RECENTE, não o do render em que foi agendado.
  //
  // Antes, o efeito dependia só de `[searchInput]` e a closure capturava `value`
  // inteiro — `tab` incluso. Digitar e trocar de aba em menos de 250 ms fazia o
  // timer disparar com a aba VELHA e devolver o operador à aba anterior, sem ele
  // ter pedido. Some em teste manual: quem sabe do defeito digita devagar.
  //
  // As refs são o que permite manter `[searchInput]` como única dependência (pôr
  // `value`/`onChange` ali reagendaria o timer a cada render e a busca nunca
  // fecharia) SEM pagar o preço da closure velha.
  const valorRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // A atualização vai num efeito, e não no corpo do render: escrever em ref
  // durante a renderização é proibido pela regra `react-hooks/refs` — o React
  // pode renderizar sem efetivar, e aí a ref passa a apontar para um estado que
  // nunca chegou à tela. O efeito roda depois do commit, quando `value` é real.
  useEffect(() => {
    valorRef.current = value;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const t = setTimeout(() => {
      const atual = valorRef.current;
      if (searchInput !== atual.search) {
        // Marca ANTES de propagar: se o efeito de sincronização rodar depois de
        // a pessoa ter digitado mais uma tecla, ele veria o valor que ESTE campo
        // acabou de mandar e o adotaria por cima do que já está na tela. Sem
        // teste que alcance — ver o aviso no efeito lá em cima.
        propagado.current = searchInput;
        onChangeRef.current({ ...atual, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ─── O POPOVER "FILTRAR CONVERSAS" (modelo do dono, 16/10/2026) ──────────
  //
  // Minhas, Não lidos, Grupos, número e tags num cartão só, atrás de um botão
  // com contador. A escolha é um RASCUNHO que só vale no "Aplicar filtros" —
  // marcar três caixas não dispara três consultas. Cada filtro ativo vira um
  // chip removível embaixo da busca, para nada ficar escondido.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const rascunhoDeAgora = (): RascunhoDosFiltros => ({
    onlyMine: value.onlyMine ?? false,
    onlyUnread: value.onlyUnread,
    onlyGroups: value.onlyGroups ?? false,
    channel_session_id: value.channel_session_id,
    ordem: value.ordem,
    tags: etiquetas,
    tagMode: value.tagMode,
  });
  const [rascunho, setRascunho] = useState<RascunhoDosFiltros>(rascunhoDeAgora);
  const abrirFiltros = (aberto: boolean) => {
    if (aberto) setRascunho(rascunhoDeAgora());
    else setBuscaDeEtiqueta("");
    setFiltrosAbertos(aberto);
  };
  const aplicarRascunho = () => {
    onChange({
      ...value,
      onlyMine: rascunho.onlyMine,
      onlyUnread: rascunho.onlyUnread,
      onlyGroups: rascunho.onlyGroups,
      channel_session_id: rascunho.channel_session_id,
      ordem: rascunho.ordem,
      tag: rascunho.tags.length === 0 ? undefined : rascunho.tags,
      tagMode: rascunho.tags.length > 1 ? rascunho.tagMode : undefined,
    });
    abrirFiltros(false);
  };
  const alternaNoRascunho = (tag: string) =>
    setRascunho((r) => ({
      ...r,
      tags: r.tags.includes(tag) ? r.tags.filter((x) => x !== tag) : [...r.tags, tag],
    }));
  const filtrosAtivos =
    (value.onlyMine ? 1 : 0) +
    (value.onlyUnread ? 1 : 0) +
    (value.onlyGroups ? 1 : 0) +
    (value.channel_session_id ? 1 : 0) +
    (value.ordem === "antigo" ? 1 : 0) +
    etiquetas.length;
  const canalEscolhido = channels?.find((c) => c.id === value.channel_session_id);
  // Mantida para o seletor de tag continuar montado enquanto o vocabulário
  // oscila (ver `ultimoVocabulario`), agora dentro do popover.
  void mostrarSeletorDeTag;

  // "/" leva à busca, como no modelo — fora de campo de texto.
  const buscaRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName)))
        return;
      e.preventDefault();
      buscaRef.current?.focus();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, []);

  const totalDaAba = countFor[value.tab];

  return (
    <>
      <header className="ibx-workspace-header">
        <div className="ibx-list-heading">
          <div className="ibx-brand">
            <span className="ibx-brand-mark">
              <Inbox size={17} aria-hidden />
            </span>
            <h1>{t("Inbox")}</h1>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="ibx-icon-button"
                    onClick={() => setAjudaAberta(true)}
                    aria-label={t("O que significa cada status do chat?")}
                  >
                    <Info className="ibx-icon" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("O que significa cada status do chat?")}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {onAbrirAtalhos && (
            <button
              type="button"
              className="ibx-icon-button"
              onClick={onAbrirAtalhos}
              aria-label={t("Atalhos do teclado")}
              title={t("Atalhos do teclado")}
            >
              <Keyboard className="ibx-icon" aria-hidden />
            </button>
          )}
        </div>
        {/* A FAIXA DE CATEGORIAS do modelo: rótulo em cima, contagem embaixo,
            sublinhado na ativa e rolagem lateral (sem barra) quando aperta. A
            contagem aparece também quando é zero — "0" é informação. As setas
            de antes continuam para quem navega pelo teclado (moveTab). */}
        <Tabs value={value.tab} onValueChange={(v) => onChange({ ...value, tab: v as InboxTab })}>
          <TabsList
            ref={tabsListRef}
            onScroll={updateMoreTabs}
            aria-label={t("Categorias de conversas")}
            className="ibx-categories"
            onKeyDown={(e) => {
              if (e.key === "Home" || e.key === "End") {
                const alvo = e.key === "Home" ? tabs[0] : tabs[tabs.length - 1];
                if (alvo) onChange({ ...value, tab: alvo });
              }
            }}
          >
            {tabs.map((tab) => {
              const meta = INBOX_TABS.find((t) => t.value === tab)!;
              const count = countFor[tab];
              return (
                <TabsTrigger key={tab} value={tab} className="ibx-category">
                  <span>{t(meta.label)}</span>
                  <span className="ibx-category-count">
                    {typeof count === "number" ? count : "–"}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        {/* Quando a faixa rola (coluna estreita, zoom alto), as setas levam à
            vizinha escondida — só a do lado em que há aba fora da vista. */}
        {(moreTabs.left || moreTabs.right) && (
          <span className="sr-only">
            {moreTabs.left && (
              <button type="button" onClick={() => moveTab(-1)}>
                {t("Aba anterior")}
              </button>
            )}
            {moreTabs.right && (
              <button type="button" onClick={() => moveTab(1)}>
                {t("Próxima aba")}
              </button>
            )}
          </span>
        )}
      </header>

      <div className="ibx-list-tools">
        <div className="ibx-search-row">
          <label className="ibx-search">
            <MagnifyingGlass className="ibx-icon" aria-hidden />
            {/* "última mensagem" continua no rótulo acessível: a busca alcança
                apenas `conversations.last_message_preview` (ver o histórico deste
                campo) — a tela não promete o que o backend não faz. */}
            <input
              ref={buscaRef}
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("Buscar nome ou telefone")}
              aria-label={t("Buscar conversas")}
              title={t("Buscar por nome, telefone ou última mensagem…")}
            />
            <kbd aria-hidden>/</kbd>
          </label>
          <Popover open={filtrosAbertos} onOpenChange={abrirFiltros}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn("ibx-filter-button", filtrosAtivos > 0 && "ibx-has-filters")}
                aria-label={t("Filtrar conversas")}
                title={t("Filtrar conversas")}
              >
                <FadersHorizontal className="ibx-icon" aria-hidden />
                {filtrosAtivos > 0 && <span className="ibx-filter-count">{filtrosAtivos}</span>}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={7}
              // O Radix reposiciona e mede o espaço livre (`--radix-popover-
              // content-available-height`), que o CSS usa como teto: o menu
              // nunca passa da janela, em qualquer zoom ou resolução.
              collisionPadding={8}
              className="ibx ibx-floating ibx-filter-popover"
            >
              <div className="ibx-popover-heading">
                <strong>{t("Filtrar conversas")}</strong>
                <button
                  type="button"
                  className="ibx-text-button"
                  onClick={() =>
                    setRascunho({ onlyMine: false, onlyUnread: false, onlyGroups: false, tags: [] })
                  }
                >
                  {t("Limpar")}
                </button>
              </div>
              {/* Só o miolo rola: o cabeçalho e o "Aplicar filtros" ficam sempre
                  à vista — antes, em tela baixa, o botão saía da janela. */}
              <div className="ibx-filter-scroll">
              <div className="ibx-filter-options">
                <label>
                  <input
                    type="checkbox"
                    checked={rascunho.onlyMine}
                    onChange={(e) => setRascunho((r) => ({ ...r, onlyMine: e.target.checked }))}
                  />
                  <span>
                    <User className="ibx-icon" aria-hidden />
                    {t("Minhas")}
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={rascunho.onlyUnread}
                    onChange={(e) => setRascunho((r) => ({ ...r, onlyUnread: e.target.checked }))}
                  />
                  <span>
                    <EnvelopeSimple className="ibx-icon" aria-hidden />
                    {t("Não lidos")}
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={rascunho.onlyGroups}
                    onChange={(e) => setRascunho((r) => ({ ...r, onlyGroups: e.target.checked }))}
                  />
                  <span>
                    <UsersThree className="ibx-icon" aria-hidden />
                    {t("Grupos")}
                  </span>
                </label>
              </div>
              {showChannelSwitch && (
                <div className="ibx-filter-field">
                  <label htmlFor="ibx-filtro-numero">{t("Canais")}</label>
                  <select
                    id="ibx-filtro-numero"
                    aria-label={t("Filtrar por canal")}
                    value={rascunho.channel_session_id ?? "all"}
                    onChange={(e) =>
                      setRascunho((r) => ({
                        ...r,
                        channel_session_id: e.target.value === "all" ? undefined : e.target.value,
                      }))
                    }
                  >
                    <option value="all">{t("Todos os canais")}</option>
                    {filtroForaDaLista && value.channel_session_id != null && (
                      <option value={value.channel_session_id}>{t("Número removido")}</option>
                    )}
                    {channels?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name || channelLabel(c)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="ibx-filter-field">
                <label htmlFor="ibx-filtro-ordem">{t("Ordem")}</label>
                <select
                  id="ibx-filtro-ordem"
                  value={rascunho.ordem ?? "recente"}
                  onChange={(e) =>
                    setRascunho((r) => ({
                      ...r,
                      ordem: e.target.value === "antigo" ? "antigo" : "recente",
                    }))
                  }
                >
                  <option value="antigo">{t("Antigo > recente")}</option>
                  <option value="recente">{t("Recente > antigo")}</option>
                </select>
              </div>
              {opcoesDoSeletor.length > 0 && (
                <fieldset className="ibx-tag-filters" aria-label={t("Filtrar por tag")}>
                  <legend>{t("Tags do contato")}</legend>
                  {opcoesDoSeletor.length > 6 && (
                    <input
                      className="ibx-tag-search"
                      value={buscaDeEtiqueta}
                      onChange={(e) => setBuscaDeEtiqueta(e.target.value)}
                      placeholder={t("Buscar etiqueta")}
                      aria-label={t("Buscar etiqueta")}
                    />
                  )}
                  <div className="ibx-tag-list">
                    {opcoesVisiveis.map((tag) => (
                      <label key={tag}>
                        <input
                          type="checkbox"
                          checked={rascunho.tags.includes(tag)}
                          onChange={() => alternaNoRascunho(tag)}
                        />
                        <PontoDaEtiqueta tag={tag} />
                        {tag}
                      </label>
                    ))}
                    {termoDaEtiqueta !== "" && opcoesVisiveis.length === 0 && (
                      <p className="mt-2 text-[10px] text-text-subtle">
                        {t("Nenhuma etiqueta com esse texto")}
                      </p>
                    )}
                  </div>
                </fieldset>
              )}
              {rascunho.tags.length > 1 && (
                <div className="ibx-filter-field">
                  <label htmlFor="ibx-filtro-modo">{t("Combinar tags")}</label>
                  <select
                    id="ibx-filtro-modo"
                    value={rascunho.tagMode === "ou" ? "ou" : "e"}
                    onChange={(e) =>
                      setRascunho((r) => ({
                        ...r,
                        tagMode: e.target.value === "ou" ? "ou" : undefined,
                      }))
                    }
                  >
                    <option value="e">{t("Todas as selecionadas (E)")}</option>
                    <option value="ou">{t("Qualquer selecionada (OU)")}</option>
                  </select>
                </div>
              )}
              </div>
              <button
                type="button"
                className="ibx-button ibx-primary ibx-filter-apply w-full"
                onClick={aplicarRascunho}
                data-testid="aplicar-filtros"
              >
                {t("Aplicar filtros")}
              </button>
            </PopoverContent>
          </Popover>
        </div>

        {filtrosAtivos > 0 && (
          <div className="ibx-active-filters" aria-label={t("Filtros ativos")}>
            {value.ordem === "antigo" && (
              <ChipDoFiltro
                rotulo={t("Antigo > recente")}
                onRemover={() => onChange({ ...value, ordem: undefined })}
              />
            )}
            {value.onlyMine && (
              <ChipDoFiltro
                rotulo={t("Minhas")}
                onRemover={() => onChange({ ...value, onlyMine: false })}
              />
            )}
            {value.onlyUnread && (
              <ChipDoFiltro
                rotulo={t("Não lidos")}
                onRemover={() => onChange({ ...value, onlyUnread: false })}
              />
            )}
            {value.onlyGroups && (
              <ChipDoFiltro
                rotulo={t("Grupos")}
                onRemover={() => onChange({ ...value, onlyGroups: false })}
              />
            )}
            {value.channel_session_id && (
              <ChipDoFiltro
                // Lista de números ainda carregando: não afirma que o número saiu.
                rotulo={
                  canalEscolhido
                    ? channelLabel(canalEscolhido)
                    : channels == null
                      ? t("Número do WhatsApp")
                      : t("Número removido")
                }
                onRemover={() => onChange({ ...value, channel_session_id: undefined })}
              />
            )}
            {etiquetas.map((tag) => (
              <ChipDoFiltro key={tag} rotulo={tag} onRemover={() => alternaEtiqueta(tag)} />
            ))}
          </div>
        )}

        <div className="ibx-list-caption">
          <span>
            {typeof totalDaAba === "number"
              ? `${totalDaAba} ${totalDaAba === 1 ? t("conversa") : t("conversas")}`
              : ""}
          </span>
        </div>
      </div>
      <Dialog open={ajudaAberta} onOpenChange={setAjudaAberta}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("O que significa cada status do chat?")}</DialogTitle>
            <DialogDescription>{t("Veja quem está aguardando uma resposta.")}</DialogDescription>
          </DialogHeader>
          <dl className="space-y-4 text-sm">
            {[
              [t("Todas"), t("Todas as conversas, inclusive as fechadas.")],
              [t("Sem resposta"), t("Primeiro contato: ainda não recebeu nenhuma resposta.")],
              [t("Em espera"), t("Já foi respondido e escreveu novamente. Aguarda sua resposta.")],
              [t("Em aberto"), t("Você enviou uma mensagem e aguarda o contato responder.")],
              [t("Fechadas"), t("Conversas com atendimento encerrado.")],
            ].map(([titulo, descricao]) => (
              <div key={titulo}>
                <dt className="font-semibold">{titulo}</dt>
                <dd className="mt-1 text-text-muted">{descricao}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChipDoFiltro({ rotulo, onRemover }: { rotulo: string; onRemover: () => void }) {
  const t = useT();
  return (
    <span className="ibx-filter-chip">
      {rotulo}
      <button type="button" onClick={onRemover} aria-label={`${t("Remover filtro")}: ${rotulo}`}>
        <X size={10} aria-hidden />
      </button>
    </span>
  );
}
