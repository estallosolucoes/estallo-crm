/**
 * A ORDEM DO FIO, num lugar só — a mesma régua do servidor
 * (`app/api/v1/messages/_handler.ts`): `sent_at`, depois `created_at`, depois `id`.
 *
 * O `sent_at` sozinho empata o tempo todo: o WhatsApp manda o horário em
 * SEGUNDOS, e uma rajada de mensagens recebidas no mesmo segundo sai com o
 * mesmo `sent_at`. O `created_at` é o instante da gravação no banco, que segue a
 * ordem de chegada, e o `id` só existe para o desempate ser total.
 */

type Ordenavel = { sent_at: string; created_at?: string | null; id: string };

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0);

export function compararMensagens(a: Ordenavel, b: Ordenavel): number {
  return (
    ms(a.sent_at) - ms(b.sent_at) ||
    ms(a.created_at) - ms(b.created_at) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * O INSTANTE DA MENSAGEM OTIMISTA não pode vir só do relógio do navegador.
 *
 * Medido em 2026-10-17: o computador de um atendente estava 37 min atrasado, e
 * a mensagem recém-enviada nascia "37 min no passado" — acima das que já
 * estavam na tela, até o servidor responder. A mensagem que eu acabo de mandar
 * é, por definição, a mais nova da conversa: o instante dela é o maior entre o
 * relógio local e o da última mensagem conhecida (+1 ms). Quando o servidor
 * responde, a linha real (com o relógio do servidor) toma o lugar dela.
 */
export function instanteOtimista(
  mensagens: ReadonlyArray<{ sent_at: string }>,
  agora: number = Date.now(),
): string {
  let ultima = 0;
  for (const m of mensagens) ultima = Math.max(ultima, ms(m.sent_at));
  return new Date(Math.max(agora, ultima + 1)).toISOString();
}
