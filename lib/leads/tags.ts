/** Regra compartilhada pela ação de automação e pelo escritor transacional. */
/**
 * Fase 5 — o bloco de tag também REMOVE. `remove`: tira só as tags pedidas que existem (as outras ficam); `add`: a regra
 * de sempre. Devolve o que mudou nos dois sentidos — quem chama só emite `tag_added` quando algo foi adicionado.
 */
export function aplicarTags(previous: readonly string[], requested: readonly string[], acao: "add" | "remove" = "add") {
  if (acao === "remove") {
    const removed = previous.filter((tag) => requested.includes(tag));
    return { added: [] as string[], removed, tags: previous.filter((tag) => !requested.includes(tag)) };
  }
  return { ...prepararAdicaoDeTags(previous, requested), removed: [] as string[] };
}

export function prepararAdicaoDeTags(previous: readonly string[], requested: readonly string[]) {
  const added = requested.filter((tag) => !previous.includes(tag));
  return { added, tags: [...previous, ...added] };
}
