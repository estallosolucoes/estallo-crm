/**
 * Tradução leiga (pt-br) dos vetos da cadeia before_send (Operação Visível F2-i).
 * Os códigos são contrato do engine (lib/agent-engine/guardrails/before-send.ts +
 * promise/disclosure) — a tela mostra POR QUE uma resposta do
 * assistente foi retida, sem jargão. Módulo puro: testável sem DOM.
 */

export type RetentionKind = "protection" | "compliance" | "quality";

export interface RetentionCopy {
  kind: RetentionKind;
  title: string;
  description: string;
}

const TITLES: Record<RetentionKind, string> = {
  protection: "Resposta segurada pela proteção do número",
  compliance: "Resposta bloqueada por conformidade",
  quality: "Resposta retida para correção",
};

/**
 * Copy por código de veto. Conformidade (stop/LGPD) é definitivo.
 * Qualidade (promise/disclosure) explica que o assistente corrige sozinho.
 */
export function retentionCopy(
  code: string | null,
  t: (texto: string) => string = (texto) => texto,
): RetentionCopy {
  const make = (kind: RetentionKind, description: string): RetentionCopy => ({
    kind,
    title: t(TITLES[kind]),
    description,
  });

  switch (code) {
    case "contato_bloqueado":
      return make(
        "compliance",
        t("O contato pediu para não receber mensagens (opt-out). Nada será enviado a ele."),
      );
    case "lgpd_anonymized":
      return make(
        "compliance",
        t("Este contato foi anonimizado (LGPD) — é proibido enviar qualquer mensagem a ele."),
      );
    case "lgpd_missing_legal_basis":
      return make(
        "compliance",
        t(
          "Não há base legal (LGPD) para o primeiro contato de prospecção com este lead. O time precisa regularizar o cadastro antes de abordar.",
        ),
      );
    case "promise_out_of_table":
      return make(
        "quality",
        t(
          "A resposta prometia um preço ou condição fora da tabela aprovada. O assistente foi orientado a corrigir antes de enviar.",
        ),
      );
    case "promise_semantic":
      return make(
        "quality",
        t("A resposta continha uma promessa não autorizada. O assistente foi orientado a reescrever antes de enviar."),
      );
    case "disclosure_required":
      return make(
        "quality",
        t(
          "A primeira mensagem a um contato novo precisa se apresentar como assistente virtual. O assistente foi orientado a corrigir antes de enviar.",
        ),
      );
    default:
      return make(
        "protection",
        `${t("Uma trava de segurança segurou esta resposta")}${code ? ` (${t("código")} ${code})` : ""}. ${t("Ela não foi enviada ao contato.")}`,
      );
  }
}
