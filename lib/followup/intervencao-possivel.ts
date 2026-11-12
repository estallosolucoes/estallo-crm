/**
 * Em que estado uma execução ainda aceita uma intervenção de uma pessoa. Moravam dentro do dossiê; o editor do fluxo
 * (histórico de execuções) é o segundo lugar que precisa da mesma regra, e duas cópias divergem na primeira vez que
 * um estado novo entra.
 */

/** Pausar, adiar e pular valem para o que o relógio ainda conduz. */
export const PAUSAVEL: ReadonlySet<string> = new Set(["active", "waiting_reply"]);

/** Pausado por uma pessoa também se cancela — sem ter de retomar antes só para encerrar. */
export const CANCELAVEL: ReadonlySet<string> = new Set(["active", "waiting_reply", "paused_handoff", "paused_manual"]);

/** Retomar vale para o que uma pessoa pausou à mão. (Pausa por passagem a humano volta pelo atendimento.) */
export const RETOMAVEL: ReadonlySet<string> = new Set(["paused_manual"]);

/** Execução que ainda está viva — andando, esperando resposta, dormente, pausada ou coletando. */
export const VIVA: ReadonlySet<string> = new Set([
  "active",
  "waiting_reply",
  "dormente",
  "paused_handoff",
  "paused_manual",
  "coletando",
]);
