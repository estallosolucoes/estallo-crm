/**
 * VARIÁVEIS DE BLOCOS ANTERIORES — `{{nodes.<id-do-bloco>.<campo>}}`, como o n8n faz com a saída de um nó.
 *
 * O texto de uma mensagem do fluxo pode citar o que um bloco ANTERIOR do mesmo caminho produziu: a saída que a
 * condição tomou, as etiquetas que o bloco de etiqueta gravou, o id da tarefa criada. A referência usa o ID do bloco
 * (estável), nunca o nome que a pessoa deu: renomear o bloco no construtor não quebra nada. A tela mostra o nome.
 *
 * Quatro regras, todas do plano (Fase 4):
 *  1. SÓ blocos ancestrais: citar um bloco futuro, ou de um ramo que não leva até este, é recusado na publicação.
 *  2. Sem `eval` e sem JavaScript: a referência é um caminho (`a.b.0.c`) lido numa estrutura de dados, e só.
 *  3. Valor ausente NUNCA sai como `{{...}}` cru nem como string vazia calada: a marca some da frase junto com o
 *     espaço vizinho (a mesma régua de `{{nome}}` em `lib/automation/texto-do-followup.ts`), e quem chamou fica
 *     sabendo QUAIS referências não resolveram.
 *  4. Só lê a saída do mesmo caminho/execução: o mapa que entra aqui é o das saídas desta inscrição.
 */
import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";

/** `{{nodes.ID.campo}}` — ID com letra, número, `_` ou `-`; caminho com ponto. */
export const MARCA_DE_BLOCO = /\{\{\s*nodes\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.]+)\s*\}\}/g;

export interface ReferenciaDeBloco {
  /** A marca inteira, como escrita. */
  marca: string;
  no_id: string;
  caminho: string;
}

/** Todas as referências a blocos que o texto cita, na ordem. */
export function extrairReferencias(texto: string): ReferenciaDeBloco[] {
  return [...texto.matchAll(MARCA_DE_BLOCO)].map((m) => ({ marca: m[0], no_id: m[1]!, caminho: m[2]! }));
}

/** Os textos de um bloco em que a pessoa pode usar variáveis (corpo do texto fixo, textos e legendas do bloco de mensagens). */
export function textosDoBloco(no: FlowNode): string[] {
  // «Aplicar em» cita um bloco anterior como qualquer texto: entra na conferência de ancestral e de dependentes.
  const alvo = "aplicar_em" in no.config && typeof no.config.aplicar_em === "string" && no.config.aplicar_em ? [no.config.aplicar_em] : [];
  return [...alvo, ...textosProprios(no)];
}

function textosProprios(no: FlowNode): string[] {
  // Mapear dados: valor e valor padrão de cada campo citam blocos anteriores pela mesma marca.
  if (no.type === "map_data") return no.config.fields.flatMap((f) => (f.fallback ? [f.value, f.fallback] : [f.value]));
  // Criar tarefa: o título pode citar a saída de um bloco anterior (ex.: um campo do Mapear dados).
  if (no.type === "internal_task") return [no.config.titulo];
  if (no.type === "add_note") return [no.config.texto];
  if (no.type === "update_lead_field") return [no.config.valor];
  if (no.type === "http_request") return [no.config.caminho, no.config.corpo];
  if (no.type === "find_or_create_contact") return [no.config.valor, no.config.nome];
  if (no.type === "find_or_create_lead") return [no.config.contato, no.config.titulo];
  if (no.type === "condition") return no.config.checks.flatMap((c) => (c.field === "variavel" && c.source ? [c.source] : []));
  if (no.type !== "action") return [];
  if (no.config.mode === "text") return [no.config.body];
  if (no.config.mode === "messages")
    return no.config.items.flatMap((i) => (i.kind === "text" ? [i.body] : i.caption ? [i.caption] : []));
  return [];
}

/** Os blocos que citam `noId` numa variável — quem fica sem valor se ele for excluído. */
export function dependentesDoNo(graph: Pick<FlowGraph, "nodes">, noId: string): FlowNode[] {
  return graph.nodes.filter((n) => n.id !== noId && textosDoBloco(n).flatMap(extrairReferencias).some((r) => r.no_id === noId));
}

/** Os ids dos blocos que podem ser percorridos ANTES de `noId` (qualquer caminho que chega nele). */
export function ancestrais(graph: Pick<FlowGraph, "edges">, noId: string): Set<string> {
  const entradas = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const lista = entradas.get(e.target);
    if (lista) lista.push(e);
    else entradas.set(e.target, [e]);
  }
  const vistos = new Set<string>();
  const fila = [noId];
  while (fila.length > 0) {
    const atual = fila.shift()!;
    for (const e of entradas.get(atual) ?? []) {
      if (vistos.has(e.source)) continue;
      vistos.add(e.source);
      fila.push(e.source);
    }
  }
  // Um laço faz o próprio bloco ser ancestral de si: ele ainda NÃO produziu saída quando o texto é montado.
  vistos.delete(noId);
  return vistos;
}

/**
 * Os campos de saída que cada tipo de bloco declara — o que o seletor oferece. Espelha `NODE_OUTPUT_CONTRACTS`
 * (`node-output-contracts.ts`); só entram campos que fazem sentido num texto. Um teste confere que cada caminho
 * existe no contrato.
 */
export const CAMPOS_DE_SAIDA: Partial<Record<FlowNode["type"], Array<{ caminho: string; rotulo: string }>>> = {
  trigger: [
    { caminho: "lead_id", rotulo: "Id do negócio" },
    { caminho: "contact_id", rotulo: "Id do contato" },
  ],
  condition: [{ caminho: "branch_id", rotulo: "Saída escolhida" }],
  edit_lead_tag: [
    { caminho: "tags", rotulo: "Etiquetas depois da alteração" },
    { caminho: "added_tags", rotulo: "Etiquetas adicionadas" },
  ],
  move_lead: [
    { caminho: "to_stage_id", rotulo: "Id da etapa de destino" },
    { caminho: "from_stage_id", rotulo: "Id da etapa de origem" },
  ],
  internal_task: [{ caminho: "task_id", rotulo: "Id da tarefa criada" }],
  add_note: [{ caminho: "note_id", rotulo: "Id da nota" }],
  update_lead_field: [{ caminho: "valor", rotulo: "Valor gravado" }],
  lead_product: [{ caminho: "item_id", rotulo: "Id do item criado" }],
  find_or_create_contact: [
    { caminho: "contact_id", rotulo: "Id do contato" },
    { caminho: "encontrado", rotulo: "Contato já existia" },
    { caminho: "criado", rotulo: "Contato foi criado" },
  ],
  find_or_create_lead: [
    { caminho: "lead_id", rotulo: "Id do negócio" },
    { caminho: "contact_id", rotulo: "Id do contato do negócio" },
    { caminho: "encontrado", rotulo: "Negócio já existia" },
    { caminho: "criado", rotulo: "Negócio foi criado" },
  ],
  http_request: [
    { caminho: "status", rotulo: "Status da resposta" },
    { caminho: "corpo", rotulo: "Corpo da resposta" },
  ],
  assign_lead_owner: [
    { caminho: "owner_user_id", rotulo: "Id do novo responsável" },
    { caminho: "previous_owner_user_id", rotulo: "Id do responsável anterior" },
  ],
};

/**
 * Os campos que ESTE bloco oferece a quem vem depois. Para quase todo tipo é a lista fixa acima; o Mapear dados
 * oferece os campos que a pessoa configurou nele (`fields.<nome>`).
 */
export function camposDeSaidaDoNo(no: FlowNode): Array<{ caminho: string; rotulo: string }> {
  if (no.type === "map_data") return no.config.fields.map((f) => ({ caminho: `fields.${f.name}`, rotulo: f.name }));
  return CAMPOS_DE_SAIDA[no.type] ?? [];
}

/** Valor → texto. Lista vira "a, b"; objeto não vira texto (retorna `null`, e a marca some). */
function emTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "string") return valor === "" ? null : valor;
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  if (Array.isArray(valor)) {
    const partes = valor.map(emTexto);
    return partes.every((p) => p !== null) && partes.length > 0 ? (partes as string[]).join(", ") : null;
  }
  return null;
}

/** Lê `a.b.0.c` numa estrutura. Só chave PRÓPRIA: `constructor`/`__proto__` nunca saem do protótipo. */
export function ler(raiz: unknown, caminho: string): unknown {
  let atual: unknown = raiz;
  for (const parte of caminho.split(".")) {
    if (atual === null || typeof atual !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(atual, parte)) return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

export interface TextoResolvido {
  texto: string;
  /** As referências que NÃO tinham valor — quem chama decide o que fazer (registrar, avisar). */
  sem_valor: ReferenciaDeBloco[];
}

/**
 * Resolve as referências do texto com as saídas desta execução (`saidas[no_id]` = o `output_snapshot` do bloco).
 * Referência sem valor some da frase junto com o espaço vizinho — nunca sai crua.
 */
export function resolverReferencias(texto: string, saidas: Record<string, unknown>): TextoResolvido {
  let saida = "";
  let cursor = 0;
  let alguma = false;
  const semValor: ReferenciaDeBloco[] = [];
  for (const m of texto.matchAll(MARCA_DE_BLOCO)) {
    const inicio = m.index ?? cursor;
    saida += texto.slice(cursor, inicio);
    const ref = { marca: m[0], no_id: m[1]!, caminho: m[2]! };
    const valor = Object.prototype.hasOwnProperty.call(saidas, ref.no_id) ? emTexto(ler(saidas[ref.no_id], ref.caminho)) : null;
    if (valor === null) {
      saida = saida.replace(/\s+$/, "");
      alguma = true;
      semValor.push(ref);
    } else {
      saida += valor;
    }
    cursor = inicio + m[0].length;
  }
  saida += texto.slice(cursor);
  return { texto: alguma ? saida.replace(/^\s+/, "") : saida, sem_valor: semValor };
}
