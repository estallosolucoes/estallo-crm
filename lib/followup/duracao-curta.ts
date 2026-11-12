/**
 * Duração de uma execução para a lista do histórico: "12 min", "3 h", "2 d". Execução em andamento mede até `agora`.
 * Abreviações universais de propósito — a coluna é estreita e dispensa tradução.
 */
export function duracaoCurta(
  inicio: string | null | undefined,
  fim: string | null | undefined,
  agora: Date,
): string | null {
  if (!inicio) return null;
  const t0 = Date.parse(inicio);
  const t1 = fim ? Date.parse(fim) : agora.getTime();
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0) return null;
  const min = Math.round((t1 - t0) / 60_000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} d`;
}
