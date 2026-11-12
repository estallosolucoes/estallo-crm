/**
 * «Aguardar até» (Fase 5): o instante-alvo de uma espera por data/horário, no fuso da ORGANIZAÇÃO.
 *
 * - Só hora: a próxima vez que o relógio do fuso marcar essa hora (hoje, se ainda não passou; senão amanhã).
 * - Data e hora: esse instante. Se já passou, a espera NÃO trava o fluxo: segue para o próximo bloco e diz isso.
 * - Data ou hora inexistente (31/02, 25:00): falha com explicação — nunca uma data "corrigida" em silêncio.
 */
import { instanteDaParede, relogioDeParede } from "@/lib/tempo/inicio-do-dia";

export type AlvoDaEspera = { ok: true; alvo: Date; ja_passou: boolean } | { ok: false; motivo: string };

export function alvoDaEsperaAte(config: { hora: string; data?: string }, fuso: string, agora: Date): AlvoDaEspera {
  const h = /^(\d{2}):(\d{2})$/.exec(config.hora);
  if (!h || Number(h[1]) > 23 || Number(h[2]) > 59)
    return { ok: false, motivo: `O horário «${config.hora}» não existe. Use HH:MM, de 00:00 a 23:59.` };
  const hora = Number(h[1]);
  const minuto = Number(h[2]);
  if (config.data !== undefined) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.data);
    const [y, mo, dia] = d ? [Number(d[1]), Number(d[2]), Number(d[3])] : [0, 0, 0];
    // Conferência pelo calendário: 2026-02-31 vira março no Date.UTC — aqui isso é data inválida.
    const cal = new Date(Date.UTC(y, mo - 1, dia));
    if (!d || cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== dia)
      return { ok: false, motivo: `A data «${config.data}» não existe no calendário.` };
    const alvo = instanteDaParede(y, mo, dia, hora, fuso, minuto);
    return { ok: true, alvo, ja_passou: alvo.getTime() <= agora.getTime() };
  }
  const hoje = relogioDeParede(agora, fuso);
  let alvo = instanteDaParede(hoje.y, hoje.mo, hoje.d, hora, fuso, minuto);
  if (alvo.getTime() <= agora.getTime()) {
    const amanha = new Date(Date.UTC(hoje.y, hoje.mo - 1, hoje.d + 1));
    alvo = instanteDaParede(amanha.getUTCFullYear(), amanha.getUTCMonth() + 1, amanha.getUTCDate(), hora, fuso, minuto);
  }
  return { ok: true, alvo, ja_passou: false };
}
