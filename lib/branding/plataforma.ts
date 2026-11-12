import { DEFAULT_APP_NAME, type Branding } from "@/lib/branding";
import { REGUA_DO_PRODUTO } from "./regua-do-produto";
import { resolverMarca } from "./resolve";

/** Identidade única do SaaS. Dados da empresa não substituem a marca do produto. */
export function marcaDaPlataforma() {
  return resolverMarca([], REGUA_DO_PRODUTO);
}

export const IDENTIDADE_DA_PLATAFORMA: Branding = {
  name: DEFAULT_APP_NAME,
  logoUrl: null,
  initial: "E",
};
