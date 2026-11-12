/**
 * PACOTE DE AUTOMAÇÃO (Fase 7) — exportar e importar um fluxo como JSON, no formato NATIVO do Estallo.
 *
 * O pacote leva o grafo (posições, configurações, variáveis), o gatilho e a política de atendimento, mais um MANIFESTO
 * das referências externas: todo UUID que o fluxo cita (etapa, funil, usuário, tipo de agenda…) com o tipo e o nome
 * na organização de origem. Não leva execuções, saídas, amostras, credenciais nem dado de cliente.
 *
 * Importar é transformação pura e verificável: ids de bloco novos (e as `{{nodes.<id>…}}` reescritas), toda referência
 * externa trocada pelo id ESCOLHIDO na organização de destino (sem casar por nome), e o grafo revalidado. Quem chama
 * confere no banco que cada id de destino pertence ao tenant e grava UM rascunho, de uma vez.
 */
import { z } from "zod";

import { flowGraphSchema, type FlowGraph } from "./graph-schema";
import { triggerConfigSchema, type FollowupFlowSurface } from "./api-schemas";

export const FORMATO_DO_PACOTE = "estallo.automacao";
export const VERSAO_DO_FORMATO = 1;
/** Teto do arquivo importado (bytes do JSON). Um fluxo real tem dezenas de KB. */
export const TETO_DO_PACOTE_BYTES = 1_000_000;

export const TIPOS_DE_REFERENCIA = ["etapa", "funil", "usuario", "tipo_de_agenda", "agente", "conexao_http", "desconhecido"] as const;
export type TipoDeReferencia = (typeof TIPOS_DE_REFERENCIA)[number];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const pacoteSchema = z.strictObject({
  formato: z.literal(FORMATO_DO_PACOTE),
  versao_do_formato: z.number().int().positive(),
  origem: z.strictObject({
    tipo: z.enum(["rascunho", "versao"]),
    versao_numero: z.number().int().positive().nullable(),
    exportado_em: z.string(),
  }),
  fluxo: z.strictObject({
    nome: z.string().min(1).max(80),
    superficie: z.enum(["followup", "crm_automation", "atendimento"]),
    handoff_policy: z.enum(["pause", "cancel", "allow"]),
    trigger_config: z.unknown(),
  }),
  grafo: z.unknown(),
  dependencias: z
    .array(z.strictObject({ id: z.string(), tipo: z.enum(TIPOS_DE_REFERENCIA), nome: z.string().max(200) }))
    .max(500),
});
export type Pacote = z.infer<typeof pacoteSchema>;

/** Todo UUID citado em qualquer string do valor (configurações, gatilho), sem repetição. */
export function uuidsCitados(valor: unknown): string[] {
  const achados = new Set<string>();
  const visita = (v: unknown): void => {
    if (typeof v === "string") for (const m of v.matchAll(UUID)) achados.add(m[0].toLowerCase());
    else if (Array.isArray(v)) v.forEach(visita);
    else if (v && typeof v === "object") Object.values(v).forEach(visita);
  };
  visita(valor);
  return [...achados];
}

/** Padrões de segredo que não podem sair num arquivo. Melhor recusar a exportação do que vazar uma chave. */
const SEGREDOS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/, "um token Bearer"],
  [/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}/, "uma chave de API"],
  [/\bdsk_[A-Za-z0-9]{12,}/, "um token de API do Estallo"],
  [/\bAKIA[0-9A-Z]{16}\b/, "uma chave da AWS"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "um token do Slack"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "uma chave privada"],
  [/\b(api[_-]?key|senha|password|secret)\s*[:=]\s*\S{6,}/i, "uma senha ou chave escrita no texto"],
];

/** Onde há segredo embutido (caminho legível + tipo). Vazio = pode exportar. */
export function segredosEmbutidos(valor: unknown): Array<{ caminho: string; tipo: string }> {
  const achados: Array<{ caminho: string; tipo: string }> = [];
  const visita = (v: unknown, caminho: string): void => {
    if (typeof v === "string") {
      for (const [re, tipo] of SEGREDOS) if (re.test(v)) achados.push({ caminho, tipo });
    } else if (Array.isArray(v)) v.forEach((x, i) => visita(x, `${caminho}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visita(x, caminho ? `${caminho}.${k}` : k);
  };
  visita(valor, "");
  return achados;
}

export function montarPacote(args: {
  nome: string;
  superficie: FollowupFlowSurface;
  handoff_policy: "pause" | "cancel" | "allow";
  trigger_config: unknown;
  grafo: FlowGraph;
  origem: Pacote["origem"];
  dependencias: Pacote["dependencias"];
}): Pacote {
  return {
    formato: FORMATO_DO_PACOTE,
    versao_do_formato: VERSAO_DO_FORMATO,
    origem: args.origem,
    fluxo: {
      nome: args.nome,
      superficie: args.superficie,
      handoff_policy: args.handoff_policy,
      trigger_config: args.trigger_config,
    },
    grafo: args.grafo,
    dependencias: args.dependencias,
  };
}

export type LeituraDoPacote =
  | { ok: true; pacote: Pacote }
  | { ok: false; motivo: string };

/** Valida o arquivo ANTES de qualquer escrita: tamanho, formato, versão e forma. */
export function lerPacote(texto: string): LeituraDoPacote {
  if (new TextEncoder().encode(texto).length > TETO_DO_PACOTE_BYTES)
    return { ok: false, motivo: "O arquivo passa de 1 MB — não parece um fluxo exportado pelo Estallo." };
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: "O arquivo não é um JSON válido." };
  }
  const obj = bruto as { formato?: unknown; versao_do_formato?: unknown };
  if (obj?.formato !== FORMATO_DO_PACOTE)
    return { ok: false, motivo: "Este arquivo não é uma automação exportada pelo Estallo." };
  if (typeof obj.versao_do_formato === "number" && obj.versao_do_formato > VERSAO_DO_FORMATO)
    return {
      ok: false,
      motivo: `O arquivo foi exportado por uma versão mais nova do Estallo (formato ${obj.versao_do_formato}). Atualize esta instalação para importá-lo.`,
    };
  const p = pacoteSchema.safeParse(bruto);
  if (!p.success) return { ok: false, motivo: "O arquivo está incompleto ou foi alterado: a estrutura não confere." };
  return { ok: true, pacote: p.data };
}

export type Importacao =
  | { ok: true; grafo: FlowGraph; trigger_config: unknown; nome: string; superficie: FollowupFlowSurface; handoff_policy: Pacote["fluxo"]["handoff_policy"] }
  | { ok: false; motivo: string; pendentes?: Pacote["dependencias"] };

/** Troca cada string inteira (ou trecho) que seja um id de origem pelo id de destino. */
function remapear(valor: unknown, troca: (s: string) => string): unknown {
  if (typeof valor === "string") return troca(valor);
  if (Array.isArray(valor)) return valor.map((v) => remapear(v, troca));
  if (valor && typeof valor === "object")
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, remapear(v, troca)]));
  return valor;
}

/**
 * Pacote + remapeamento → grafo novo, pronto para virar UM rascunho. Toda dependência precisa de um destino
 * escolhido (nome igual não autoriza vínculo). `novoId` gera os ids de bloco (injetado para teste).
 */
export function importarPacote(pacote: Pacote, mapa: Record<string, string>, novoId: () => string): Importacao {
  const pendentes = pacote.dependencias.filter((d) => !mapa[d.id]);
  if (pendentes.length > 0)
    return { ok: false, motivo: "Escolha, na organização de destino, o equivalente de cada referência do fluxo.", pendentes };
  const grafoOrigem = flowGraphSchema.safeParse(pacote.grafo);
  if (!grafoOrigem.success) return { ok: false, motivo: "O fluxo do arquivo não é válido para este formato." };

  const ids = new Map(grafoOrigem.data.nodes.map((n) => [n.id, novoId()]));
  const externos = new Map(Object.entries(mapa).map(([de, para]) => [de.toLowerCase(), para]));
  const troca = (s: string): string =>
    s
      // {{nodes.<id-antigo>.campo}} → id novo (a referência sobrevive à troca de ids)
      .replace(/(\{\{\s*nodes\.)([A-Za-z0-9_-]+)(\.)/g, (m, a: string, id: string, b: string) =>
        ids.has(id) ? `${a}${ids.get(id)}${b}` : m,
      )
      .replace(UUID, (u) => externos.get(u.toLowerCase()) ?? u);

  const g = grafoOrigem.data;
  const grafo = {
    ...g,
    nodes: g.nodes.map((n) => ({ ...n, id: ids.get(n.id)!, config: remapear(n.config, troca) })),
    edges: g.edges.map((e) => ({ ...e, id: novoId(), source: ids.get(e.source)!, target: ids.get(e.target)! })),
  };
  const valido = flowGraphSchema.safeParse(grafo);
  if (!valido.success) return { ok: false, motivo: "O fluxo ficou inválido depois do remapeamento." };
  const gatilho = remapear(pacote.fluxo.trigger_config, troca);
  if (!triggerConfigSchema.safeParse(gatilho).success)
    return { ok: false, motivo: "O gatilho do fluxo não é válido nesta instalação." };
  return {
    ok: true,
    grafo: valido.data,
    trigger_config: gatilho,
    nome: pacote.fluxo.nome,
    superficie: pacote.fluxo.superficie,
    handoff_policy: pacote.fluxo.handoff_policy,
  };
}
