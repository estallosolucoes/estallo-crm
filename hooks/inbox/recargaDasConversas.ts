import type { InfiniteData, QueryClient } from "@tanstack/react-query";

/**
 * A RECARGA QUE O REALTIME PEDE, AGRUPADA — e sem cancelar a busca em voo.
 *
 * Uma única mensagem que chega gera uma RAJADA de eventos (o INSERT em
 * `messages` e várias escritas em `conversations`), e cada evento invalidava
 * `["conversations"]` na hora. `invalidateQueries` cancela a busca em curso
 * (`cancelRefetch` é o padrão), então a rajada virava várias buscas da lista,
 * cada uma cancelando a anterior — no trace do CI, 5 GET em 5ms.
 *
 * O que isto NÃO é: a causa da falha intermitente do e2e
 * `encerramento-atendimento`. O controle aprovado (run 37329560310) tem a
 * MESMA rajada de 5 GET cancelados e passou; o que separou a falha (run
 * 37320609105) foi o servidor respondendo em ~4s pedidos que nunca são
 * cancelados. O ganho aqui é menos carga, não o conserto daquela asserção.
 *
 * Duas regras, e as duas importam:
 *  - a rajada vira UMA busca, que começa depois da janela;
 *  - se já há busca da lista em voo, ESPERA ela terminar e só então recarrega.
 *    Cancelar perde a resposta; não recarregar perde a escrita que chegou
 *    depois de ela começar.
 *
 * Também recarrega `["conversation", id]` — a conversa aberta que NÃO está na
 * aba atual (fechada, de outro filtro) vem só dessa busca, e nenhum evento a
 * alcançava: ela ficava velha até um F5.
 *
 * Por QueryClient, e não por hook: os dois canais do inbox (lista e mensagens)
 * pedem a mesma recarga, e agrupar só um deles deixaria o outro cancelando.
 */
const JANELA_MS = 150;
const agendadas = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

export function agendarRecargaDasConversas(qc: QueryClient): void {
  if (agendadas.has(qc)) return;
  agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
}

function descarregar(qc: QueryClient): void {
  // ponytail: espera por polling na janela; sem teto — uma busca que nunca
  // termina adia a recarga até ela falhar, que é o que o cancelamento fazia pior.
  if (qc.isFetching({ queryKey: ["conversations"] }) > 0) {
    agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
    return;
  }
  agendadas.delete(qc);
  void qc.invalidateQueries({ queryKey: ["conversations"] });
  void qc.invalidateQueries({ queryKey: ["conversation"] });
  // O status do chat (Em espera / Em aberto) muda com cada mensagem: o
  // contador das abas acompanha a lista, não o polling de 30 s.
  void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
}

/**
 * A PRÉVIA NÃO PODE ANDAR NA FRENTE DO FIO.
 *
 * A prévia da lista vem do canal `conversations` (a coluna
 * `last_message_preview`); o fio aberto vem do canal `messages-<id>`. São dois
 * canais, e quando o segundo perdia um evento (remonte do fio, queda, RLS que
 * atrasa) o atendente via a mensagem nova NA LISTA e não na conversa aberta —
 * relatado em 2026-10-17. Aqui o evento da conversa confere o fio que está em
 * cache: se a conversa diz ter mensagem mais nova que a última do fio, o fio é
 * relido. Sem polling e sem releitura quando os dois já concordam.
 */
export function alinharFioComAPrevia(qc: QueryClient, payload: unknown): void {
  const nova = (payload as { new?: { id?: unknown; last_message_at?: unknown } } | null)?.new;
  if (typeof nova?.id !== "string" || typeof nova.last_message_at !== "string") return;
  const chave = ["messages", nova.id];
  const fio = qc.getQueryData<InfiniteData<{ data: Array<{ sent_at: string }> }>>(chave);
  if (!fio) return;
  const ultima = fio.pages[0]?.data.at(-1)?.sent_at;
  if (!ultima || Date.parse(nova.last_message_at) > Date.parse(ultima)) {
    void qc.invalidateQueries({ queryKey: chave });
  }
}

/**
 * A PRÉVIA NA HORA (30/10/2026): grava campos de UMA conversa em toda lista em
 * cache, sem esperar a recarga. A recarga (que reordena e traz os campos
 * calculados) continua vindo atrás; isto só tira a defasagem de quem olha.
 *
 * Usado pelo Realtime (o `new` do UPDATE — colunas, nunca os joins nem os campos
 * calculados, que ficam como estavam) e pelo envio otimista (`useSendMessage`).
 */
export function gravarNaConversaDaLista(
  qc: QueryClient,
  conversationId: string,
  campos: Record<string, unknown>,
): void {
  qc.setQueriesData<InfiniteData<{ data: Array<{ id: string }> }>>({ queryKey: ["conversations"] }, (old) => {
    if (!old?.pages) return old;
    let mudou = false;
    const pages = old.pages.map((page) => {
      if (!page.data.some((c) => c.id === conversationId)) return page;
      mudou = true;
      return { ...page, data: page.data.map((c) => (c.id === conversationId ? { ...c, ...campos } : c)) };
    });
    return mudou ? { ...old, pages } : old;
  });
}
