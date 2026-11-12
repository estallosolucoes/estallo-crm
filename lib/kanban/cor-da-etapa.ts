/**
 * Cor de etapa do funil (`crm_stages.color`, CHECK `^#[0-9a-fA-F]{6}$`).
 *
 * Etapa nova nasce com uma cor da paleta sorteada, nunca igual à da etapa
 * anterior — assim duas colunas vizinhas do quadro não se confundem.
 */
export const PALETA_DE_ETAPAS = [
  "#3b82f6", // azul
  "#06b6d4", // ciano
  "#10b981", // verde
  "#84cc16", // lima
  "#eab308", // amarelo
  "#f97316", // laranja
  "#ef4444", // vermelho
  "#ec4899", // rosa
  "#8b5cf6", // violeta
  "#64748b", // ardósia
] as const;

export const COR_DE_ETAPA = /^#[0-9a-fA-F]{6}$/;

export function corParaNovaEtapa(
  corAnterior: string | null | undefined,
  sortear: () => number = Math.random,
): string {
  const anterior = corAnterior?.toLowerCase();
  const opcoes = PALETA_DE_ETAPAS.filter((c) => c !== anterior);
  return opcoes[Math.floor(sortear() * opcoes.length)] ?? opcoes[0]!;
}
