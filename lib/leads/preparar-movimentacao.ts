import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { RECUSA_DE_TROCA_DE_FUNIL } from "./clonar-para-funil";
import { modoDeReabertura, recusaReabertura } from "./reabertura";
import {
  validaCamposExigidos,
  recusaDeCamposObrigatorios,
  recusaDeMotivoDoGanho,
} from "./campos-exigidos";
import { decideMotivoDaPerda } from "./motivo-da-perda";

export interface LeadDaMovimentacao extends Record<string, unknown> {
  id: string;
  pipeline_id: string | null;
  stage_id: string | null;
  status?: string | null;
  lost_reason?: string | null;
}
export interface EtapaDaMovimentacao {
  id: string;
  pipeline_id: string;
  name?: string | null;
  is_won?: boolean | null;
  is_lost?: boolean | null;
}
export type PreparacaoDaMovimentacao =
  | { ok: true; patch: { lost_reason?: string; won_reason?: string }; mesma_etapa: boolean }
  | {
      ok: false;
      status: number;
      codigo: string;
      mensagem: string;
      details?: Record<string, unknown>;
    };

/** Ordem única das regras comerciais para o handler canônico e o writer PG. */
export function prepararMovimentacaoDeLead(input: {
  lead: LeadDaMovimentacao;
  etapa: EtapaDaMovimentacao;
  settings: unknown;
  lost_reason?: string | null;
  won_reason?: string | null;
  idioma?: Idioma | null;
  /**
   * Fase 5 — o bloco Mover do follow-up também troca de FUNIL (o mesmo negócio, como `/move-pipeline`). As regras de lá
   * valem aqui: só negócio ABERTO muda de funil, e só para etapa ABERTA (ganho e perda fecham por outro caminho). Os
   * campos obrigatórios conferidos são os do funil de DESTINO (`settings` vem dele). Sem a opção, recusa como sempre.
   */
  permitirTrocaDeFunil?: boolean;
}): PreparacaoDaMovimentacao {
  const { lead, etapa, settings, idioma } = input;
  if (etapa.pipeline_id !== lead.pipeline_id && input.permitirTrocaDeFunil) {
    if ((lead.status ?? "open") !== "open")
      return { ok: false, status: 422, codigo: "lead_not_open", mensagem: traduzir("Só um negócio aberto muda de funil.", idioma ?? "pt-BR") };
    if (etapa.is_won || etapa.is_lost)
      return {
        ok: false,
        status: 422,
        codigo: "destino_fechado",
        mensagem: traduzir(
          "Para trocar de funil, escolha uma etapa aberta. Ganho e perda se marcam dentro do funil do negócio.",
          idioma ?? "pt-BR",
        ),
      };
  } else if (etapa.pipeline_id !== lead.pipeline_id)
    return {
      ok: false,
      status: 422,
      codigo: "pipeline_immutable_use_clone",
      details: { use: "/api/v1/leads/{id}/clone" },
      mensagem: traduzir(RECUSA_DE_TROCA_DE_FUNIL, idioma ?? "pt-BR"),
    };
  const reopening = recusaReabertura({
    modo: modoDeReabertura(settings),
    statusAtual: lead.status,
    etapaDestino: etapa,
    idioma: idioma ?? undefined,
  });
  if (reopening)
    return {
      ok: false,
      status: 409,
      codigo: reopening.codigo,
      mensagem: reopening.mensagem,
      details: { use: "/api/v1/leads/{id}/retomar", lead_id: lead.id },
    };
  const mesmaEtapa = etapa.id === lead.stage_id;
  const required = mesmaEtapa
    ? { faltando: [] }
    : validaCamposExigidos({
        lead,
        settingsDoFunil: settings,
        destino: {
          stageId: etapa.id,
          desfecho: etapa.is_won ? "won" : etapa.is_lost ? "lost" : null,
        },
        motivoDeGanho: input.won_reason ?? null,
      });
  if (required.faltando.length) {
    const refusal = recusaDeCamposObrigatorios(required.faltando, idioma);
    return {
      ok: false,
      status: 422,
      codigo: refusal.codigo,
      mensagem: refusal.mensagem,
      details: { faltando: required.faltando },
    };
  }
  if (etapa.is_won) {
    const refusal = recusaDeMotivoDoGanho({
      motivo: input.won_reason,
      settingsDoFunil: settings,
      idioma,
    });
    if (refusal)
      return { ok: false, status: 422, codigo: refusal.codigo, mensagem: refusal.mensagem };
  }
  const loss = decideMotivoDaPerda({
    etapaDeDestino: etapa,
    motivo: input.lost_reason,
    motivoAtual: lead.lost_reason ?? null,
    idioma,
  });
  if (!loss.ok) return { ok: false, status: 422, codigo: loss.codigo, mensagem: loss.mensagem };
  return {
    ok: true,
    mesma_etapa: mesmaEtapa,
    patch: {
      ...loss.patch,
      ...(etapa.is_won && input.won_reason?.trim() ? { won_reason: input.won_reason.trim() } : {}),
    },
  };
}
