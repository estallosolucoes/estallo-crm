/** Saídas de produto usam a identidade fixa; documentos legais identificam a empresa. */
import { DEFAULT_APP_NAME } from "@/lib/branding";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { melhorFrenteSobre } from "./contraste";
import { stop } from "./rampa";
import { REGUA_DO_PRODUTO } from "./regua-do-produto";

export type MarcaDeSaida = {
  readonly nome: string;
  readonly logoUrl: string | null;
  readonly logoDarkUrl?: string | null;
  readonly accent: string;
  readonly accentFg: string;
  readonly origens: { readonly nome: string; readonly cor: string };
};

export const NEUTROS_DE_SAIDA = {
  texto: stop(REGUA_DO_PRODUTO.claro.neutros, 9),
  suave: stop(REGUA_DO_PRODUTO.claro.neutros, 5),
  fundo: stop(REGUA_DO_PRODUTO.claro.neutros, 0),
  linha: stop(REGUA_DO_PRODUTO.claro.neutros, 2),
} as const;

/** A organização informa o contexto, mas não troca a marca do aplicativo. Sem I/O. */
export async function marcaDaSaida(_organizationId: string | null): Promise<MarcaDeSaida> {
  const accent = stop(REGUA_DO_PRODUTO.rampaDoProduto, REGUA_DO_PRODUTO.claro.indices.accent);
  return {
    nome: DEFAULT_APP_NAME,
    logoUrl: null,
    accent,
    accentFg: melhorFrenteSobre(accent),
    origens: { nome: "padrao", cor: "padrao" },
  };
}

/** O endereço continua configurável pela operação da Estallo, sem fallback para upstream. */
export async function emailDeSuporte(): Promise<string> {
  const { valor } = await valorDaInstalacao("SUPPORT_EMAIL");
  return (valor ?? "").trim();
}
