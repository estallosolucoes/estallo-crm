/** Identidade central do produto. O resolvedor genérico fica como compatibilidade legada. */
export const DEFAULT_APP_NAME = "Estallo CRM";

export type Branding = {
  /** Nome exibido na interface e nos títulos de página. */
  name: string;
  /** URL do logo, ou `null` quando a marca deve aparecer como texto. */
  logoUrl: string | null;
  /** Arte opcional preparada para o tema escuro; ausente preserva o logo padrão. */
  logoDarkUrl?: string | null;
  /** Primeira letra do nome — usada onde só cabe um caractere (sidebar recolhida). */
  initial: string;
};

/**
 * Resolve a marca a partir dos valores crus. Função pura: recebe a fonte, não a
 * procura — assim o mesmo resolvedor serve servidor, navegador e teste.
 *
 * Valor vazio ou só com espaços cai no padrão. Isso importa porque `.env` gerado
 * por script costuma trazer a chave declarada e vazia (`APP_NAME=`), e tratar isso
 * como "marca sem nome" deixaria a interface em branco.
 */
export function resolveBranding(
  name: string | undefined | null,
  logoUrl: string | undefined | null,
): Branding {
  const resolvedName = (name ?? "").trim() || DEFAULT_APP_NAME;
  const resolvedLogo = (logoUrl ?? "").trim();
  return {
    name: resolvedName,
    logoUrl: resolvedLogo.length > 0 ? resolvedLogo : null,
    // Spread em vez de [0]: nome começando com emoji ou acento composto quebraria
    // no meio do code point e renderizaria caractere inválido.
    initial: ([...resolvedName][0] ?? DEFAULT_APP_NAME[0]!).toUpperCase(),
  };
}

/** O desenho oficial só acompanha a identidade padrão nos consumidores legados. */
export function marcaEhADoProduto(marca: Pick<Branding, "name" | "logoUrl">): boolean {
  return marca.logoUrl === null && marca.name === DEFAULT_APP_NAME;
}

export function branding(): Branding {
  return resolveBranding(undefined, undefined);
}
