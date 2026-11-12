import { RITMO_MAXIMO_MS } from "@/lib/messaging/ritmo-entre-envios";

/**
 * O INTERVALO DA ESTEIRA FRIA LEVA JITTER.
 *
 * O agendamento exato (`now + N minutos`, sempre o mesmo número de milissegundos) é cadência de robô, que é justamente
 * o que a detecção de automação procura. O jitter aqui só ATRASA (nunca adianta): adiantar poderia furar o intervalo
 * mínimo que o operador configurou, e o sentido do erro tem de ser sempre o mais lento.
 *
 * Não há mais teto de aquecimento próprio da esteira fria: a "Proteção de envio" do canal deixou de existir, e o que
 * limita a prospecção é só o que a campanha declara (`daily_limit`, `interval_minutes`) e o teto de 50 abordagens por
 * 24 h do worker.
 */
export function proximoEnvioDaEsteiraFria(
  agora: Date,
  intervalMinutes: number,
  rng: () => number = Math.random,
): Date {
  const base = intervalMinutes * 60_000;
  const jitter = Math.floor(rng() * (RITMO_MAXIMO_MS + 1));
  return new Date(agora.getTime() + base + jitter);
}
