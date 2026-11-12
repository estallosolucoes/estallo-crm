/**
 * A CONVERSA EM QUE O ATENDENTE ACABOU DE AGIR FICA NA LISTA.
 *
 * Responder em "Em espera" muda o status do chat para "Em aberto" — e a lista
 * filtrada, relida pelo tempo real, deixava de trazê-la: a linha sumia debaixo
 * do cursor e o painel piscava. A mudança de status continua acontecendo no
 * banco (e o contador da aba acompanha); só a LISTA À VISTA a segura no lugar
 * em que estava, até o atendente trocar de aba/filtro ou recarregar a página.
 *
 * Só vale para as conversas que o próprio usuário tocou: as outras seguem a
 * lista do servidor sem retenção.
 */
export interface Retida<T> {
  conversa: T;
  /** Posição na lista no momento em que o usuário agiu. */
  indice: number;
}

export function listaComRetidas<T extends { id: string }>(
  itens: readonly T[],
  retidas: ReadonlyArray<Retida<T>>,
): T[] {
  if (retidas.length === 0) return itens as T[];
  const presentes = new Set(itens.map((i) => i.id));
  const saida = [...itens];
  for (const r of [...retidas].sort((a, b) => a.indice - b.indice)) {
    if (presentes.has(r.conversa.id)) continue;
    saida.splice(Math.min(Math.max(r.indice, 0), saida.length), 0, r.conversa);
    presentes.add(r.conversa.id);
  }
  return saida;
}
