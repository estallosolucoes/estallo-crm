/**
 * MAPEAR DADOS — o bloco que monta campos novos a partir das saídas dos blocos anteriores (Fase 4).
 *
 * Cada campo tem um nome (o que os blocos seguintes citam: `{{nodes.<bloco>.fields.<nome>}}`), um valor e um tipo.
 * O valor é texto com referências `{{nodes.<bloco>.<caminho>}}`:
 *  - referência SOZINHA (o valor inteiro é uma marca) lê o valor cru, preservando lista, número e `null`;
 *  - qualquer outra coisa é COMPOSIÇÃO de texto: cada marca vira texto no lugar dela.
 *
 * As regras do plano, sem exceção:
 *  - ausente, `null`, string vazia e lista vazia são coisas diferentes. Ausente sem fallback FALHA com explicação;
 *    `null` lido de uma referência sozinha segue `null`; na composição, valor sem texto conta como ausente;
 *  - fallback só quando configurado, e passa pela mesma conversão;
 *  - conversão é explícita pelo tipo; o que não converte falha, nunca vira string vazia ou zero;
 *  - sem `eval`: a leitura é `ler()` (só chave própria) e a conversão é tabela fixa.
 */
import { ler, MARCA_DE_BLOCO } from "./variaveis-de-blocos";

export type TipoDoCampo = "text" | "number" | "boolean" | "list";
export type ValorMapeado = string | number | boolean | string[] | null;

export interface CampoDoMapa {
  name: string;
  value: string;
  type: TipoDoCampo;
  fallback?: string;
}

export type ResultadoDoMapa =
  | { ok: true; fields: Record<string, ValorMapeado> }
  | { ok: false; campo: string; motivo: string };

const AUSENTE = Symbol("ausente");

function emTexto(v: unknown): string | typeof AUSENTE {
  if (v === undefined || v === null) return AUSENTE;
  if (typeof v === "string") return v === "" ? AUSENTE : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.length > 0) {
    const partes = v.map(emTexto);
    return partes.includes(AUSENTE) ? AUSENTE : (partes as string[]).join(", ");
  }
  return AUSENTE;
}

/** O valor cru (referência sozinha) ou o texto composto; `AUSENTE` quando falta algo que o valor cita. */
function resolver(valor: string, saidas: Record<string, unknown>): { cru: unknown } | { ausente: string } {
  const so = new RegExp(`^\\s*${MARCA_DE_BLOCO.source}\\s*$`).exec(valor);
  const lerRef = (no: string, caminho: string) =>
    Object.prototype.hasOwnProperty.call(saidas, no) ? ler(saidas[no], caminho) : undefined;
  if (so) {
    const cru = lerRef(so[1]!, so[2]!);
    return cru === undefined ? { ausente: so[0].trim() } : { cru };
  }
  let falta: string | null = null;
  const texto = valor.replace(MARCA_DE_BLOCO, (marca, no: string, caminho: string) => {
    const t = emTexto(lerRef(no, caminho));
    if (t === AUSENTE) {
      falta ??= marca;
      return "";
    }
    return t;
  });
  return falta ? { ausente: falta } : { cru: texto };
}

const VERDADE = new Set(["true", "sim", "s", "yes", "1"]);
const FALSO = new Set(["false", "não", "nao", "n", "no", "0"]);

function converter(cru: unknown, tipo: TipoDoCampo): { valor: ValorMapeado } | { erro: string } {
  if (cru === null) return { valor: null };
  switch (tipo) {
    case "text": {
      if (typeof cru === "string") return { valor: cru };
      const t = emTexto(cru);
      return t === AUSENTE ? { erro: "o valor não pode virar texto" } : { valor: t };
    }
    case "number": {
      if (typeof cru === "number") return Number.isFinite(cru) ? { valor: cru } : { erro: "não é um número" };
      if (typeof cru !== "string" || cru.trim() === "") return { erro: "não é um número" };
      const n = Number(cru.trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
      return Number.isFinite(n) ? { valor: n } : { erro: `"${cru}" não é um número` };
    }
    case "boolean": {
      if (typeof cru === "boolean") return { valor: cru };
      const s = String(cru).trim().toLowerCase();
      if (VERDADE.has(s)) return { valor: true };
      if (FALSO.has(s)) return { valor: false };
      return { erro: `"${String(cru)}" não é sim/não` };
    }
    case "list": {
      if (Array.isArray(cru)) {
        const itens = cru.map((i) => (typeof i === "string" ? i : emTexto(i)));
        return itens.includes(AUSENTE) ? { erro: "a lista tem item que não vira texto" } : { valor: itens as string[] };
      }
      if (typeof cru === "string") return { valor: cru.split(",").map((s) => s.trim()).filter(Boolean) };
      return { erro: "não é uma lista" };
    }
  }
}

/** Monta os campos com as saídas DESTA execução (`saidas[no_id]` = saída do bloco). Puro e determinístico. */
export function mapearDados(campos: readonly CampoDoMapa[], saidas: Record<string, unknown>): ResultadoDoMapa {
  const fields: Record<string, ValorMapeado> = {};
  for (const campo of campos) {
    let r = resolver(campo.value, saidas);
    if ("ausente" in r && campo.fallback !== undefined) r = resolver(campo.fallback, saidas);
    if ("ausente" in r) {
      return {
        ok: false,
        campo: campo.name,
        motivo: `O campo «${campo.name}» cita ${r.ausente}, que não tem valor nesta execução, e não há valor padrão configurado.`,
      };
    }
    const c = converter(r.cru, campo.type);
    if ("erro" in c) return { ok: false, campo: campo.name, motivo: `O campo «${campo.name}»: ${c.erro}.` };
    fields[campo.name] = c.valor;
  }
  return { ok: true, fields };
}
