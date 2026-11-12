/**
 * Meia-noite LOCAL de um fuso — o corte do "hoje" dos tetos diários.
 *
 * Intl puro, sem dependência. `instantFromWall` usa a técnica de duas passadas pelo offset, correta inclusive sob DST.
 */
export interface RelogioDeParede {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function relogioDeParede(instante: Date, fuso: string): RelogioDeParede {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instante);
  const pega = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value ?? "0");
  return {
    y: pega("year"),
    mo: pega("month"),
    d: pega("day"),
    h: pega("hour") % 24, // algumas ICU rendem '24' à meia-noite
    mi: pega("minute"),
    s: pega("second"),
  };
}

/** O instante em que o relógio de parede do fuso marca y-mo-d h:mi (correto sob horário de verão). */
export function instanteDaParede(y: number, mo: number, d: number, h: number, fuso: string, mi = 0): Date {
  const alvoComoUtc = Date.UTC(y, mo - 1, d, h, mi);
  let palpite = alvoComoUtc;
  for (let i = 0; i < 2; i += 1) {
    const w = relogioDeParede(new Date(palpite), fuso);
    palpite += alvoComoUtc - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  }
  return new Date(palpite);
}

/** Meia-noite LOCAL do fuso contendo `instante`. */
export function inicioDoDiaNoFuso(instante: Date, fuso: string): Date {
  const w = relogioDeParede(instante, fuso);
  return instanteDaParede(w.y, w.mo, w.d, 0, fuso);
}
