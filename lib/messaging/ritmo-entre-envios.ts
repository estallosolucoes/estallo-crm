/**
 * O RITMO ENTRE ENVIOS DO WHATSAPP NÃO OFICIAL — um número só, para todos.
 *
 * Substitui a antiga "Proteção de envio" (janela de horário, aquecimento, teto diário, intervalo por canal).
 * Não há mais nada para configurar: toda mensagem que sai por um número sem API oficial espera entre 0,3 e 0,8 s
 * depois da anterior do MESMO número. O intervalo é sorteado a cada envio — intervalo fixo é assinatura de robô.
 *
 * O estado é de processo: o worker, o cron e o Next têm cada um o seu relógio. Duas mensagens de processos
 * diferentes para o mesmo número no mesmo instante podem sair coladas. ponytail: sem ledger compartilhado,
 * porque a janela é de meio segundo; se virar problema medido, o lugar de guardar o último envio é o banco.
 */

/** Intervalo mínimo entre dois envios do mesmo número (ms). */
export const RITMO_MINIMO_MS = 300;

/** Intervalo máximo entre dois envios do mesmo número (ms). */
export const RITMO_MAXIMO_MS = 800;

const ultimoEnvioPorNumero = new Map<string, number>();

/**
 * Quanto esperar antes de enviar agora, em ms, e reserva o horário: o próximo envio do número conta a partir dele.
 * `rng` e `agora` são injetáveis para teste.
 */
export function reservarRitmo(
  numeroId: string,
  agora: number = Date.now(),
  rng: () => number = Math.random,
): number {
  const intervalo = RITMO_MINIMO_MS + Math.floor(rng() * (RITMO_MAXIMO_MS - RITMO_MINIMO_MS + 1));
  const ultimo = ultimoEnvioPorNumero.get(numeroId);
  const espera = ultimo === undefined ? 0 : Math.max(0, ultimo + intervalo - agora);
  ultimoEnvioPorNumero.set(numeroId, agora + espera);
  return espera;
}

/** Espera o ritmo do número e só então devolve — chame imediatamente antes de entregar a mensagem ao canal. */
export async function esperarRitmo(
  numeroId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const espera = reservarRitmo(numeroId);
  if (espera > 0) await sleep(espera);
}
