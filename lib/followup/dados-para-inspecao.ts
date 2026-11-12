/**
 * Como um valor de entrada/saída/configuração de bloco é MOSTRADO no inspetor (Fase 4). Puro: nenhuma leitura de banco.
 *
 * A regra que importa: ausência não vira texto vazio por omissão. «Sem valor» (`undefined`), `null`, texto vazio,
 * lista vazia e objeto vazio são cinco coisas diferentes, e o inspetor as nomeia — é assim que quem investiga uma
 * mensagem que saiu em branco enxerga se o campo faltou, veio nulo ou veio vazio.
 *
 * As três visões (árvore, tabela, JSON) saem do MESMO valor: a árvore e a tabela são derivadas de `linhasDoValor`,
 * o JSON é o próprio valor — por isso mostram o mesmo conteúdo.
 */

export type TipoDoValor =
  | "ausente"
  | "nulo"
  | "texto_vazio"
  | "lista_vazia"
  | "objeto_vazio"
  | "texto"
  | "numero"
  | "booleano"
  | "lista"
  | "objeto";

export const ROTULO_DO_TIPO: Record<TipoDoValor, string> = {
  ausente: "sem valor",
  nulo: "nulo",
  texto_vazio: "texto vazio",
  lista_vazia: "lista vazia",
  objeto_vazio: "objeto vazio",
  texto: "texto",
  numero: "número",
  booleano: "sim/não",
  lista: "lista",
  objeto: "objeto",
};

export function tipoDoValor(v: unknown): TipoDoValor {
  if (v === undefined) return "ausente";
  if (v === null) return "nulo";
  if (typeof v === "string") return v === "" ? "texto_vazio" : "texto";
  if (typeof v === "number" || typeof v === "bigint") return "numero";
  if (typeof v === "boolean") return "booleano";
  if (Array.isArray(v)) return v.length === 0 ? "lista_vazia" : "lista";
  if (typeof v === "object") return Object.keys(v as object).length === 0 ? "objeto_vazio" : "objeto";
  return "texto";
}

export interface LinhaDoValor {
  /** `a.b[0].c`; vazio para a raiz quando ela é um valor simples. */
  caminho: string;
  tipo: TipoDoValor;
  /** Texto curto do valor para exibir; contêineres mostram o tamanho, não o conteúdo. */
  valor: string;
  /** Profundidade, para recuar a árvore. */
  nivel: number;
}

const LIMITE_DE_LINHAS = 500;

function resumo(v: unknown, tipo: TipoDoValor): string {
  switch (tipo) {
    case "ausente":
      return "—";
    case "nulo":
      return "null";
    case "texto_vazio":
      return '""';
    case "lista_vazia":
      return "[]";
    case "objeto_vazio":
      return "{}";
    case "lista":
      return `${(v as unknown[]).length} itens`;
    case "objeto":
      return `${Object.keys(v as object).length} campos`;
    default:
      return String(v);
  }
}

/** Achata o valor em linhas (uma por campo/posição), na ordem em que aparecem. Corta em 500 e avisa por `cortado`. */
export function linhasDoValor(valor: unknown): { linhas: LinhaDoValor[]; cortado: boolean } {
  const linhas: LinhaDoValor[] = [];
  let cortado = false;
  const visita = (v: unknown, caminho: string, nivel: number): void => {
    if (linhas.length >= LIMITE_DE_LINHAS) {
      cortado = true;
      return;
    }
    const tipo = tipoDoValor(v);
    linhas.push({ caminho, tipo, valor: resumo(v, tipo), nivel });
    if (tipo === "lista") (v as unknown[]).forEach((x, i) => visita(x, `${caminho}[${i}]`, nivel + 1));
    else if (tipo === "objeto") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visita(x, caminho ? `${caminho}.${k}` : k, nivel + 1);
    }
  };
  visita(valor, "", 0);
  return { linhas, cortado };
}

/** Busca por caminho ou valor, sem diferenciar maiúsculas. Busca vazia devolve tudo. */
export function filtrarLinhas(linhas: LinhaDoValor[], busca: string): LinhaDoValor[] {
  const q = busca.trim().toLowerCase();
  if (!q) return linhas;
  return linhas.filter((l) => l.caminho.toLowerCase().includes(q) || l.valor.toLowerCase().includes(q));
}

/** JSON para ler e copiar; `undefined` (que o JSON não representa) vira texto explícito em vez de sumir. */
export function jsonParaCopiar(valor: unknown): string {
  return valor === undefined ? "(sem valor)" : JSON.stringify(valor, null, 2);
}
