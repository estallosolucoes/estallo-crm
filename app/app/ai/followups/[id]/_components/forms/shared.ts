import type { FlowNode } from "@/lib/followup/graph-schema";

/** Config do nó daquele `type` — o mesmo estreitamento que o painel usa para escolher o formulário. */
export type ConfigOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>["config"];

export function msToMin(ms: number): number {
  return Math.round(ms / 60_000);
}

export function minToMs(min: number): number {
  return Math.round(min * 60_000);
}

/** Unidades da espera, da maior para a menor — a ordem é a da escolha da unidade em `msParaValorEUnidade`. */
export const UNIDADES_DE_TEMPO = [
  { unidade: "dias", ms: 86_400_000 },
  { unidade: "horas", ms: 3_600_000 },
  { unidade: "minutos", ms: 60_000 },
  { unidade: "segundos", ms: 1_000 },
] as const;

export type UnidadeDeTempo = (typeof UNIDADES_DE_TEMPO)[number]["unidade"];

/** A maior unidade que divide o tempo sem sobra: 180000 → 3 minutos, 7200000 → 2 horas. */
export function msParaValorEUnidade(ms: number): { valor: number; unidade: UnidadeDeTempo } {
  const segundos = UNIDADES_DE_TEMPO[3];
  const u = UNIDADES_DE_TEMPO.find((x) => ms >= x.ms && ms % x.ms === 0) ?? segundos;
  return { valor: Math.round(ms / u.ms), unidade: u.unidade };
}

export function valorEUnidadeParaMs(valor: number, unidade: UnidadeDeTempo): number {
  const u = UNIDADES_DE_TEMPO.find((x) => x.unidade === unidade)!;
  return Math.round(valor * u.ms);
}
