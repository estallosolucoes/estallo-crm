import type { ComponentType } from "react";

import { Bell, Play, Clock, GitBranch, Brain, ChatCircle, ArrowsClockwise, PaperPlaneTilt, Flag, Question, PuzzlePiece, Funnel, Tag, ArrowsLeftRight, UserCircle, Note, PencilSimple, Package, Globe, IdentificationCard, Target } from "@/lib/ui/icons";
import type { FlowNode, NodeType } from "@/lib/followup/graph-schema";
import { RESULTADOS_DO_FIM } from "@/lib/followup/vocabulario";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import { NODE_CATALOG } from "@/lib/followup/node-catalog";

/**
 * Visual identity per node type — shared by the palette (Task 6.2 increment 2)
 * and the custom node cards (increment 3). Each type gets a DISTINCT icon +
 * Sage token pairing (never a bare default React Flow box): trigger=accent
 * (start), wait=info (calm/waiting), condition=warning (branch), ai_classify=
 * solid accent (the "smart" step), action=success (send/go), end=error
 * (terminal — reads as "stop", not literally an error).
 */
export interface NodeVisual {
  type: NodeType;
  paletteLabel: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Icon chip background + text. */
  chipClassName: string;
  /** Left accent border on the node card. */
  borderClassName: string;
  defaultLabel: string;
  defaultConfig: () => FlowNode["config"];
}

type RegraDeCondicao = Extract<FlowNode, { type: "condition" }>["config"]["checks"][number];

/**
 * A regra com que o nó de condição nasce, e a que o "+ Condição" acrescenta.
 *
 * Era `passos ≥ 0` — válida no schema e VERDADEIRA PARA TODO LEAD (o contador
 * nasce em zero e só soma). No modo uma-saída-por-regra ela desviava todo mundo
 * e tornava "Nenhuma delas" inalcançável; num OU, fixava o nó em "Sim". E o card
 * a mostrava com cara de regra pronta.
 *
 * Agora nasce INCOMPLETA de propósito: o schema aceita (o rascunho salva), o
 * motor nunca a satisfaz e o publish a recusa até alguém escolher a etapa. Etapa
 * porque é a pergunta mais comum de um funil — e a que o seletor responde sem
 * digitar nada.
 */
export function regraEmBranco(): RegraDeCondicao {
  return { field: "lead_stage", op: "eq", value: "" };
}

/**
 * Nó de mensagem novo: IA, salvo o gatilho de retorno — ali o padrão é texto
 * fixo, porque a saudação de quem voltou não pede o LLM (e duas vozes
 * nasceriam se o default fosse `ai_message` + o turno inbound).
 */
export function configPadraoDaAcao(triggerKind?: string): FlowNode["config"] {
  if (triggerKind === "inbound_after_silence") {
    return { mode: "text", body: "Configure esta mensagem." };
  }
  return { mode: "ai_message", prompt_hint: "Configure esta etapa." };
}

export const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  trigger: {
    type: "trigger",
    paletteLabel: NODE_CATALOG.trigger.label,
    icon: Play,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Início do fluxo",
    defaultConfig: () => ({}),
  },
  wait: {
    type: "wait",
    paletteLabel: NODE_CATALOG.wait.label,
    icon: Clock,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Aguardar",
    defaultConfig: () => ({ mode: "fixed", duration_ms: 300_000 }),
  },
  condition: {
    type: "condition",
    paletteLabel: NODE_CATALOG.condition.label,
    icon: GitBranch,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Verificar condição",
    defaultConfig: () => ({ combinator: "and", checks: [regraEmBranco()] }),
  },
  ai_classify: {
    type: "ai_classify",
    paletteLabel: NODE_CATALOG.ai_classify.label,
    icon: Brain,
    chipClassName: "bg-accent text-accent-foreground dark:bg-accent-700",
    borderClassName: "border-l-accent-700",
    defaultLabel: "Classificar resposta",
    defaultConfig: () => ({
      // Em português, e dizendo o CRITÉRIO: estes nomes são a definição inteira
      // que o modelo recebe para classificar a resposta (`followup-flow-classify`),
      // e aparecem crus na saída do card, na aresta e no dossiê. "hot"/"cold"
      // pedia ao dono da loja que adivinhasse o critério — e ao modelo também.
      // Fora do dicionário de propósito: são DADO do usuário, e uma chave faria
      // o card traduzir o que o motor compara ao pé da letra.
      classes: ["Interessado", "Sem interesse"],
      grace_timeout_ms: 900_000,
      target: "last_reply",
    }),
  },
  match_reply: {
    type: "match_reply",
    paletteLabel: NODE_CATALOG.match_reply.label,
    icon: ChatCircle,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Casar resposta",
    defaultConfig: () => ({
      branches: [{ id: "br_sim", label: "Sim", op: "contains", pattern: "sim" }],
      grace_timeout_ms: 900_000,
    }),
  },
  repeat: {
    type: "repeat",
    paletteLabel: NODE_CATALOG.repeat.label,
    icon: ArrowsClockwise,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Repetir pela resposta",
    defaultConfig: () => ({ max_count: 12 }),
  },
  collect: {
    type: "collect",
    paletteLabel: NODE_CATALOG.collect.label,
    icon: Question,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Nova pergunta",
    defaultConfig: () => ({ key: "novo_campo", label: "Nova pergunta", type: "text", required: true, permite_correcao: true }),
  },
  skill: {
    type: "skill",
    paletteLabel: NODE_CATALOG.skill.label,
    icon: PuzzlePiece,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Puxar skill",
    defaultConfig: () => ({ skill_name: "nome-da-skill" }),
  },
  action: {
    type: "action",
    paletteLabel: NODE_CATALOG.action.label,
    icon: PaperPlaneTilt,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => configPadraoDaAcao(),
  },
  internal_task: {
    type: "internal_task",
    paletteLabel: NODE_CATALOG.internal_task.label,
    icon: Bell,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Criar tarefa (só interno)",
    defaultConfig: () => ({
      titulo: "Ligar para {{contact.name}}",
      vence_em_dias: 1,
      atribuir_a: "dono_do_lead",
      prioridade: "medium",
    }),
  },
  // #2065 — os dois tipos de ação que a issue pede e que NÃO falam com o
  // cliente: mover o card no funil e gravar tag. O `defaultConfig` nasce vazio
  // de propósito (rascunho salva trabalho pela metade); o publish é quem exige
  // a escolha (`etapa_destino_ausente`, `tag_ausente`).
  move_lead: {
    type: "move_lead",
    paletteLabel: NODE_CATALOG.move_lead.label,
    icon: Funnel,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Mover card de etapa",
    defaultConfig: () => ({ stage_id: "" }),
  },
  edit_lead_tag: {
    type: "edit_lead_tag",
    paletteLabel: NODE_CATALOG.edit_lead_tag.label,
    icon: Tag,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Gravar tag no lead",
    defaultConfig: () => ({ tags: [] }),
  },
  lead_product: {
    type: "lead_product",
    paletteLabel: NODE_CATALOG.lead_product.label,
    icon: Package,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Produto do negócio",
    defaultConfig: () => ({ acao: "add", product_id: "", quantidade: 1 }),
  },
  find_or_create_contact: {
    type: "find_or_create_contact",
    paletteLabel: NODE_CATALOG.find_or_create_contact.label,
    icon: IdentificationCard,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Buscar ou criar contato",
    defaultConfig: () => ({ busca: "phone", valor: "", criar: true, nome: "" }),
  },
  find_or_create_lead: {
    type: "find_or_create_lead",
    paletteLabel: NODE_CATALOG.find_or_create_lead.label,
    icon: Target,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Buscar ou criar negócio",
    defaultConfig: () => ({ contato: "", pipeline_id: "", stage_id: "", titulo: "", criar: true }),
  },
  http_request: {
    type: "http_request",
    paletteLabel: NODE_CATALOG.http_request.label,
    icon: Globe,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Requisição HTTP",
    defaultConfig: () => ({ connection_id: "", metodo: "GET", caminho: "/", corpo: "" }),
  },
  update_lead_field: {
    type: "update_lead_field",
    paletteLabel: NODE_CATALOG.update_lead_field.label,
    icon: PencilSimple,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Atualizar campo do negócio",
    defaultConfig: () => ({ alvo: "custom_field", chave: "", valor: "" }),
  },
  add_note: {
    type: "add_note",
    paletteLabel: NODE_CATALOG.add_note.label,
    icon: Note,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Nota interna",
    defaultConfig: () => ({ destino: "lead_timeline", texto: "" }),
  },
  assign_lead_owner: {
    type: "assign_lead_owner",
    paletteLabel: NODE_CATALOG.assign_lead_owner.label,
    icon: UserCircle,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Atribuir responsável",
    defaultConfig: () => ({ usuario_id: "" }),
  },
  map_data: {
    type: "map_data",
    paletteLabel: NODE_CATALOG.map_data.label,
    icon: ArrowsLeftRight,
    chipClassName: "bg-surface-muted text-text",
    borderClassName: "border-l-border-strong",
    defaultLabel: "Mapear dados",
    defaultConfig: () => ({ fields: [] }),
  },
  end: {
    type: "end",
    paletteLabel: NODE_CATALOG.end.label,
    icon: Flag,
    chipClassName: "bg-error-bg text-error-fg",
    borderClassName: "border-l-error",
    defaultLabel: "Fim do fluxo",
    defaultConfig: () => ({ outcome: "exhausted" }),
  },
};

/**
 * A paleta do editor de follow-up: só o que o motor do RELÓGIO executa. Pergunta
 * e Skill são do roteiro de atendimento (#1130) e ficam fora — a mesma lista
 * que o publish cobra (`NOS_DA_SUPERFICIE`), para a tela não oferecer caixa que
 * o publish recusa.
 */
export const NODE_VISUAL_LIST = NOS_DA_SUPERFICIE.followup.map((tipo) => NODE_VISUALS[tipo]);

type ConfigOf<T extends NodeType> = Extract<FlowNode, { type: T }>["config"];

/** "15 min", com espaço — o mesmo formato do card de espera, que dizia "5 min" enquanto este dizia "15min". */
function minutos(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** Espera fixa na unidade em que foi escolhida: "30 s", "3 min", "2 h", "1 d". */
function tempoCurto(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))} s`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  return minutos(ms);
}

/**
 * One-line summary of a node's config — shown as the card subtitle. Takes the
 * RF node's own `type`/`data.config` pair (not a reconstructed `FlowNode`)
 * because the node components only ever see React Flow's generic shape.
 */
export function describeNodeConfig(
  type: NodeType,
  config: FlowNode["config"],
  // `t` OBRIGATÓRIO. Era opcional com padrão identidade, e foi assim que dois
  // cards que chegaram por outra branch (repetir e casar resposta) ficaram sem
  // tradução nenhuma sem o typecheck notar: em português o padrão devolve o
  // mesmo texto, então o esquecimento só aparecia para quem usa espanhol.
  t: (texto: string) => string,
): string {
  switch (type) {
    case "trigger":
      return t("Início do fluxo");
    case "wait": {
      const c = config as ConfigOf<"wait">;
      if (c.mode === "until") return c.data ? `${t("até")} ${c.data} ${c.hora}` : `${t("até as")} ${c.hora}`;
      return c.mode === "fixed"
        ? tempoCurto(c.duration_ms)
        : `${Math.round(c.min_ms / 60_000)}–${minutos(c.max_ms)} ${t("(adaptativo)")}`;
    }
    case "condition": {
      const c = config as ConfigOf<"condition">;
      // No modo uma-saída-por-regra o combinador NÃO é consultado (a regra não
      // vota, ela roteia). Continuar anunciando "E"/"OU" ali seria o card
      // afirmando uma coisa que o motor ignora — e o usuário acredita no card.
      if (c.branching === "per_check")
        return `${c.checks.length} ${c.checks.length === 1 ? t("regra · uma saída por regra") : t("regras · uma saída por regra")}`;
      return `${c.checks.length} ${c.checks.length === 1 ? t("condição") : t("condições")} · ${c.combinator === "and" ? t("E") : t("OU")}`;
    }
    // "grace" é o nome do CAMPO, não palavra nenhuma para quem tem uma loja — e o
    // formulário do mesmo nó já perguntava "Esperar a resposta por (minutos)".
    // O card dizia o número com dois nomes na mesma tela.
    case "ai_classify": {
      const c = config as ConfigOf<"ai_classify">;
      return `${c.classes.length} ${c.classes.length === 1 ? t("classe · espera") : t("classes · espera")} ${minutos(c.grace_timeout_ms)}`;
    }
    case "match_reply": {
      const c = config as ConfigOf<"match_reply">;
      return `${c.branches.length} ${c.branches.length === 1 ? t("regra · espera") : t("regras · espera")} ${minutos(c.grace_timeout_ms)}${
        c.save_to
          ? ` · ${t("grava resposta")}${c.if_exists === "skip" ? ` · ${t("pula se já existir")}` : c.if_exists === "confirm" ? ` · ${t("confirma se já existir")}` : ""}`
          : ""
      }`;
    }
    case "repeat": {
      const c = config as ConfigOf<"repeat">;
      return `${t("até")} ${c.max_count} ${c.max_count === 1 ? t("volta") : t("voltas")}`;
    }
    case "collect": {
      const c = config as ConfigOf<"collect">;
      return `${c.label} · ${c.required ? t("obrigatória") : t("opcional")}`;
    }
    case "skill": {
      const c = config as ConfigOf<"skill">;
      return c.skill_name;
    }
    case "action": {
      const c = config as ConfigOf<"action">;
      if (c.mode === "ai_message") return c.prompt_hint;
      if (c.mode === "text") return c.body;
      if (c.mode === "messages") {
        const anexos = c.items.filter((i) => i.kind !== "text").length;
        const textos = c.items.length - anexos;
        return [
          textos > 0 ? `${textos} ${textos === 1 ? t("texto") : t("textos")}` : null,
          anexos > 0 ? `${anexos} ${anexos === 1 ? t("anexo") : t("anexos")}` : null,
        ]
          .filter(Boolean)
          .join(" + ");
      }
      return t("Template fixo");
    }
    case "internal_task": {
      const c = config as ConfigOf<"internal_task">;
      const prazo = c.vence_em_dias === 0 ? t("hoje") : `+${c.vence_em_dias}d`;
      return `${c.titulo} · ${prazo} · ${t("sem mensagem ao cliente")}`;
    }
    // #2065 — o rótulo da etapa (nome de banco) não chega aqui: o card diz o
    // QUE faz, e o formulário diz PARA ONDE, com o nome da etapa escolhida.
    case "move_lead": {
      const c = config as ConfigOf<"move_lead">;
      return c.stage_id ? t("move o card para outra etapa do funil") : t("sem etapa de destino");
    }
    case "edit_lead_tag": {
      const c = config as ConfigOf<"edit_lead_tag">;
      if (!c.tags.length) return t("sem tag escolhida");
      const lista = c.acao === "remove" ? `− ${c.tags.join(", ")}` : c.tags.join(", ");
      return c.destino === "contato" ? `${lista} (${t("no contato")})` : lista;
    }
    case "find_or_create_contact": {
      const c = config as ConfigOf<"find_or_create_contact">;
      if (!c.valor.trim()) return t("sem valor para procurar");
      return c.criar ? t("procura e cria se não achar") : t("só procura");
    }
    case "find_or_create_lead": {
      const c = config as ConfigOf<"find_or_create_lead">;
      if (!c.pipeline_id) return t("sem funil escolhido");
      return c.criar ? t("procura e cria se não achar") : t("só procura");
    }
    case "http_request": {
      const c = config as ConfigOf<"http_request">;
      if (!c.connection_id) return t("sem conexão escolhida");
      return `${c.metodo} ${c.caminho || "/"}`;
    }
    case "lead_product": {
      const c = config as ConfigOf<"lead_product">;
      if (!c.product_id) return t("sem produto escolhido");
      return c.acao === "remove" ? t("tira o produto do negócio") : `+${c.quantidade} · ${t("produto do catálogo")}`;
    }
    case "update_lead_field": {
      const c = config as ConfigOf<"update_lead_field">;
      if (!c.valor.trim()) return t("sem valor");
      if (c.alvo === "deal_value") return t("valor do negócio");
      return c.chave ? (c.alvo === "contact_field" ? `${c.chave} (${t("no contato")})` : c.chave) : t("sem campo escolhido");
    }
    case "add_note": {
      const c = config as ConfigOf<"add_note">;
      if (!c.texto.trim()) return t("sem texto");
      return c.destino === "conversation_notes" ? t("nota na conversa") : t("nota no negócio");
    }
    case "assign_lead_owner": {
      const c = config as ConfigOf<"assign_lead_owner">;
      return c.usuario_id ? t("troca o responsável do negócio") : t("sem responsável escolhido");
    }
    case "map_data": {
      const c = config as ConfigOf<"map_data">;
      return c.fields.length ? c.fields.map((f) => f.name).join(", ") : t("sem campos");
    }
    case "end": {
      const c = config as ConfigOf<"end">;
      return t(RESULTADOS_DO_FIM[c.outcome]);
    }
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}
