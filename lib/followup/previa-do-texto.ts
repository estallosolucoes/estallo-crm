/**
 * PRÉVIA do texto de uma mensagem no editor (Fase 4): como a frase sairia com uma AMOSTRA EXPLÍCITA. Pura, sem banco e
 * sem dado de cliente — a amostra é fixa e a tela a rotula «exemplo simulado». Não é o valor de nenhuma execução.
 *
 * A régua é a do envio de verdade: variável sem valor some da frase junto com o espaço vizinho (nunca sai `{{...}}` cru
 * nem string vazia calada), e a prévia diz QUAIS variáveis ficariam sem valor com esta amostra.
 */
import type { FlowGraph, FlowNode } from "./graph-schema";
import { ancestrais, camposDeSaidaDoNo, resolverReferencias } from "./variaveis-de-blocos";

const CONTATO_DE_EXEMPLO: Record<string, string> = {
  nome: "Maria Souza",
  primeiro_nome: "Maria",
  telefone: "+55 11 99999-0000",
  email: "maria@exemplo.com",
  "lead.title": "Negócio de exemplo",
  volta: "1",
  voltas: "3",
};

/** Valor de exemplo por campo de saída; o que não está aqui vira texto genérico. */
function valorDeExemplo(caminho: string): unknown {
  if (caminho === "branch_id") return "sim";
  if (caminho.endsWith("tags")) return ["etiqueta-de-exemplo"];
  return `${caminho}-de-exemplo`;
}

/**
 * A saída de EXEMPLO de um bloco — a mesma amostra que a prévia usa. É exemplo simulado: nunca dado de execução.
 * `null` quando o bloco não oferece campos para citar.
 */
export function saidaDeExemplo(no: FlowNode): Record<string, unknown> | null {
  const campos = camposDeSaidaDoNo(no);
  if (campos.length === 0) return null;
  const saida: Record<string, unknown> = {};
  for (const c of campos) {
    // `fields.nome` (Mapear dados) vira objeto aninhado, como a saída real.
    const [primeiro, ...resto] = c.caminho.split(".");
    if (resto.length === 0) saida[primeiro!] = valorDeExemplo(c.caminho);
    else ((saida[primeiro!] ??= {}) as Record<string, unknown>)[resto.join(".")] = `${resto.join(".")}-de-exemplo`;
  }
  return saida;
}

export interface PreviaDoTexto {
  texto: string;
  /** Variáveis que ficariam sem valor com a amostra (marca inteira, como escrita). */
  sem_valor: string[];
}

/**
 * As saídas de uma execução REAL escolhida como amostra: por bloco, a do último passo concluído (numa volta, a última
 * visita vale — a mesma régua do motor). Passo sem saída visível (sem permissão, falhou) não entra.
 */
export function saidasDosPassos(
  passos: ReadonlyArray<{ node_id: string; status: string; saida?: unknown }>,
): Record<string, unknown> {
  const saidas: Record<string, unknown> = {};
  for (const p of passos) if (p.status === "succeeded" && p.saida !== undefined && p.saida !== null) saidas[p.node_id] = p.saida;
  return saidas;
}

export function previaDoTexto(
  texto: string,
  grafo: Pick<FlowGraph, "nodes" | "edges"> | null,
  noId: string | null,
  /** Saídas de uma execução real escolhida como amostra; sem isto, o exemplo simulado. */
  saidasReais?: Record<string, unknown>,
): PreviaDoTexto {
  // 1) saídas (de exemplo, ou da execução escolhida) só dos blocos que podem vir ANTES do aberto
  const saidas: Record<string, unknown> = {};
  if (grafo && noId) {
    const anteriores = ancestrais(grafo, noId);
    for (const no of grafo.nodes) {
      if (!anteriores.has(no.id)) continue;
      if (saidasReais) {
        if (Object.prototype.hasOwnProperty.call(saidasReais, no.id)) saidas[no.id] = saidasReais[no.id];
        continue;
      }
      const exemplo = saidaDeExemplo(no);
      if (exemplo) saidas[no.id] = exemplo;
    }
  }
  const blocos = resolverReferencias(texto, saidas);
  const semValor = blocos.sem_valor.map((r) => r.marca);

  // 2) variáveis do contato e da volta, com a mesma regra de «some junto com o espaço»
  let saida = "";
  let cursor = 0;
  let alguma = false;
  for (const m of blocos.texto.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const inicio = m.index ?? cursor;
    saida += blocos.texto.slice(cursor, inicio);
    const valor = Object.prototype.hasOwnProperty.call(CONTATO_DE_EXEMPLO, m[1]!) ? CONTATO_DE_EXEMPLO[m[1]!]! : null;
    if (valor === null) {
      saida = saida.replace(/\s+$/, "");
      alguma = true;
      semValor.push(m[0]);
    } else saida += valor;
    cursor = inicio + m[0].length;
  }
  saida += blocos.texto.slice(cursor);
  return { texto: alguma ? saida.replace(/^\s+/, "") : saida, sem_valor: semValor };
}
