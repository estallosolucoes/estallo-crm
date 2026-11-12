/**
 * Por que uma execução está parada, em palavras de quem opera. Só descreve o que o banco sabe (estado, próximo
 * disparo, tentativas, bloco atual) — nada é deduzido. `null` quando a execução terminou ou não está esperando.
 */
export interface EntradaDaEspera {
  status: string;
  next_eval_at: string | null;
  motor_ocupado?: boolean;
  attempts: number;
  max_attempts: number;
  rotuloDoBlocoAtual: string | null;
}

export function motivoDaEspera(
  e: EntradaDaEspera,
  t: (texto: string) => string,
  formatar: (iso: string) => string,
): string | null {
  const bloco = e.rotuloDoBlocoAtual ? ` «${e.rotuloDoBlocoAtual}»` : "";
  const quando = e.next_eval_at ? formatar(e.next_eval_at) : null;
  switch (e.status) {
    case "waiting_reply":
      return quando
        ? `${t("Esperando a resposta do contato no bloco")}${bloco}. ${t("Se ela não vier, o fluxo segue em")} ${quando}.`
        : `${t("Esperando a resposta do contato no bloco")}${bloco}.`;
    case "dormente":
      return quando
        ? `${t("Dormindo até")} ${quando}${bloco ? ` (${t("bloco")}${bloco})` : ""}.`
        : t("Dormindo, à espera da data de retorno.");
    case "active":
      if (e.motor_ocupado) return t("O motor está processando esta execução agora.");
      if (e.attempts > 0 && quando) {
        return `${t("Nova tentativa do bloco")}${bloco} ${t("em")} ${quando} (${e.attempts}/${e.max_attempts}).`;
      }
      return quando ? `${t("Próximo passo")}${bloco} ${t("agendado para")} ${quando}.` : null;
    case "paused_manual":
      return t("Pausada por uma pessoa. Retome para o fluxo voltar a andar.");
    case "paused_handoff":
      return t("Pausada porque a conversa foi para um atendente.");
    case "coletando":
      return t("O roteiro de atendimento está em andamento com o contato.");
    default:
      return null;
  }
}
