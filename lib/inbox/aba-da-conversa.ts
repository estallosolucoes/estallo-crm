/**
 * Em qual aba de STATUS uma conversa conta — a regra de `public.status_do_chat`
 * (baseline, migration 0663) em TypeScript, só para o ajuste OTIMISTA das
 * contagens ao fechar/reabrir (`useCloseConversation`). Quem decide de verdade
 * é o banco: a contagem é recarregada logo depois e corrige qualquer desvio.
 *
 *   terminal (closed/archived) → "closed"
 *   grupo                      → nenhuma aba de status
 *   cliente escreveu, ninguém respondeu → "pendentes" (Sem resposta)
 *   cliente escreveu depois da nossa última → "em_espera"
 *   nossa saída é a última     → "em_aberto"
 */
export type AbaDeStatus = "closed" | "pendentes" | "em_espera" | "em_aberto";

const TERMINAIS = new Set(["closed", "archived"]);

export interface ConversaParaAba {
  status: string;
  is_group?: boolean | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export function abaDaConversa(c: ConversaParaAba): AbaDeStatus | null {
  if (TERMINAIS.has(c.status)) return "closed";
  if (c.is_group) return null;
  if (c.last_inbound_at && !c.last_outbound_at) return "pendentes";
  if (c.last_outbound_at && c.last_inbound_at && c.last_inbound_at > c.last_outbound_at) return "em_espera";
  if (c.last_outbound_at) return "em_aberto";
  return null;
}

/** As contagens depois de a conversa trocar de status (`novoStatus`). */
export function contagensDepoisDe<T extends Partial<Record<AbaDeStatus, number>>>(
  contagens: T,
  conversa: ConversaParaAba,
  novoStatus: string,
): T {
  const de = abaDaConversa(conversa);
  const para = abaDaConversa({ ...conversa, status: novoStatus });
  if (de === para) return contagens;
  const out = { ...contagens };
  if (de && typeof out[de] === "number") out[de] = Math.max(0, (out[de] as number) - 1) as T[typeof de];
  if (para && typeof out[para] === "number") out[para] = ((out[para] as number) + 1) as T[typeof para];
  return out;
}
