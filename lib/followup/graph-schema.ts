import { z } from 'zod';

import { PRIORIDADES_DA_TAREFA } from '@/lib/tarefas/tipos';

/**
 * Flow graph schema for the follow-up automation system.
 * Defines types and Zod validators for nodes, edges, and complete graphs.
 */

export const NODE_TYPES = [
  'trigger',
  'wait',
  'condition',
  'ai_classify',
  'match_reply',
  'repeat',
  'collect',
  'skill',
  'action',
  // Lembrete interno (#1540): grava `crm_tasks` e NÃO envia mensagem. É a caixa
  // que advocacia, saúde e serviços regulados precisam — o sistema lembra a
  // equipe, a mensagem sai de uma pessoa.
  'internal_task',
  // #2065: dois tipos de ACAO que não falam com o cliente — o fluxo deixa de
  // só mandar mensagem. `move_lead` move o card para outra etapa (o mesmo
  // escritor de etapa do board/automação), `edit_lead_tag` grava tag no lead
  // (a MESMA `add_tag` do motor de automação). "Disparar campanha" ficou de
  // fora desta fatia e é o passo seguinte da issue.
  'move_lead',
  'edit_lead_tag',
  // Fase 4: monta campos novos a partir das saídas dos blocos anteriores (`lib/followup/mapear-dados.ts`). Sem efeito.
  'map_data',
  // Fase 5: troca o responsável do negócio (a mesma régua da ação `assign_owner`). Não transfere o atendimento.
  'assign_lead_owner',
  // Fase 5: nota interna no negócio (linha do tempo) ou na conversa (notas internas), no destino escolhido.
  'add_note',
  // Fase 5: grava um campo personalizado do negócio (do catálogo) ou o valor do negócio.
  'update_lead_field',
  // Fase 5: adiciona ou remove um produto do catálogo no negócio (o valor é recalculado pelo banco).
  'lead_product',
  // Fase 5: chama um sistema externo por uma conexão protegida (o segredo nunca está no fluxo).
  'http_request',
  // Fase 5: acham (e, se pedido, criam) contato e negócio; os blocos seguintes miram o resultado por «Aplicar em».
  'find_or_create_contact',
  'find_or_create_lead',
  'end',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * ---------------------------------------------------------------------------
 * Named branches (graph v2)
 * ---------------------------------------------------------------------------
 * A fan-out node used to collapse N rules into ONE boolean (`condition`) or to
 * address its outputs by a mutable human string (`ai_classify` + `class_match`),
 * so the builder could only ever draw a single source handle and a rename
 * silently detached the edge. v2 gives every output of a node a STABLE ID —
 * the branch — and lets an edge reference `branch_id` instead.
 *
 * The branch belongs to the NODE, never to the edge: replicating the rule
 * inside the edge would duplicate the truth and break on reorder.
 *
 * Every v2 field below is OPTIONAL and every v1 field keeps its exact type, so
 * a graph written by the previous version parses byte-identical (no default is
 * injected, nothing is rewritten) and keeps routing through the v1 conditions.
 * Read the storage shape through `nodeBranches()` — it is the only place that
 * knows which dialect a node speaks.
 */

/** The catch-all output every node has. Spelled `{ type: 'always' }` on the wire — never as a `branch`. */
export const FALLBACK_BRANCH_ID = 'else';
/** `ai_classify` grace timeout expired without a classification. */
export const NO_REPLY_BRANCH_ID = 'no_reply';
/** The two outputs of a `condition` node evaluating its checks together (`branching: 'combined'`). */
export const CONDITION_TRUE_BRANCH_ID = 'true';
export const CONDITION_FALSE_BRANCH_ID = 'false';
/** Saída do `repeat` enquanto ainda faltam voltas. */
export const REPEAT_BODY_BRANCH_ID = 'body';
/** Saída do `repeat` quando o contador chegou a zero. */
export const REPEAT_DONE_BRANCH_ID = 'done';
/**
 * "Fallback erro": por onde o fluxo CONTINUA quando o bloco falha de vez (sem nova tentativa
 * possível) no motor novo. Opcional — sem ela, a falha para a inscrição e abre aviso na Central.
 */
export const ON_ERROR_BRANCH_ID = 'on_error';

/** Branch ids the contract owns — a user-declared branch may not claim one. */
export const RESERVED_BRANCH_IDS = [
  FALLBACK_BRANCH_ID,
  NO_REPLY_BRANCH_ID,
  CONDITION_TRUE_BRANCH_ID,
  CONDITION_FALSE_BRANCH_ID,
  REPEAT_BODY_BRANCH_ID,
  REPEAT_DONE_BRANCH_ID,
  ON_ERROR_BRANCH_ID,
] as const;

/** Id of a branch the user declared (a check, an AI class) — opaque, stable across renames. */
export const declaredBranchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((id) => !(RESERVED_BRANCH_IDS as readonly string[]).includes(id), {
    message: `branch id is reserved: ${RESERVED_BRANCH_IDS.join(', ')}`,
  });

/** Id an edge may reference. Excludes the fallback, which has exactly one spelling: `{ type: 'always' }`. */
export const edgeBranchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((id) => id !== FALLBACK_BRANCH_ID, {
    message: `the fallback branch "${FALLBACK_BRANCH_ID}" is spelled { type: 'always' } on an edge`,
  });

/**
 * Wait node configuration schema.
 * Supports two modes:
 * - fixed: absolute wait duration in milliseconds (5 min to 90 days)
 * - smart: adaptive wait with min/max range and optional guidance
 */
export const waitConfigSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('fixed'),
      // Piso de 1 s: quem escolhe a espera é quem monta o fluxo (3 min entre o agradecimento e o áudio).
      // A precisão real é a do tick do motor (~1 min); o ciclo sem espera segue barrado na publicação
      // (`MIN_CYCLE_WAIT_MS`, validate-publish).
      duration_ms: z.number().int().min(1_000).max(7_776_000_000),
      /**
       * A espera NÃO é encurtada nem cancelada quando o contato manda mensagem.
       *
       * Existe para a cadência longa — o retorno de manutenção de 28 dias — em
       * que o cliente falar hoje não é motivo para antecipar um toque de daqui a
       * um mês. Sem isto, `lib/followup/reactivity.ts` ou cancela a inscrição
       * (`cancel_on_reply`) ou grava `inbound_woke` e corta o timer: os dois
       * desfechos matam a cadência, e era por isso que a regra de retorno vivia
       * no prompt do agente chamando `crm_schedule_followup`.
       *
       * Só em `fixed`: `smart` é "a IA escolhe dentro de uma faixa", e faixa
       * adaptativa com imunidade é combinação que ninguém pediu. O `strictObject`
       * do outro membro já recusa a chave — vira teste, não código.
       *
       * Em runtime isto vira o status `dormente` da inscrição (quem projeta é o
       * handler do nó, em `node-handlers.ts`), e é o status que tira a inscrição
       * do alcance da reatividade e libera o slot único anti-spam.
       */
      immune_to_reply: z.boolean().optional(),
    }),
    // Fase 5 — «aguardar até»: a hora (e, opcional, a data) no fuso da organização (`lib/followup/espera-ate.ts`).
    // Data/hora inexistente falha na execução; data já passada segue para o próximo bloco.
    z.strictObject({
      mode: z.literal('until'),
      hora: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD.').optional(),
    }),
    z.strictObject({
      mode: z.literal('smart'),
      min_ms: z.number().int().min(300_000),
      max_ms: z.number().int().max(7_776_000_000),
      guidance: z.string().max(500).optional(),
    }),
  ])
  .refine((c) => c.mode !== 'smart' || c.min_ms <= c.max_ms, {
    message: 'min_ms must be <= max_ms',
    path: ['min_ms'],
  });

/** A declared output of an `ai_classify` node: opaque id + the class name the LLM is asked to pick. */
export const aiClassBranchSchema = z.strictObject({
  id: declaredBranchIdSchema,
  label: z.string().min(1).max(40),
});

export type AiClassBranch = z.infer<typeof aiClassBranchSchema>;

/** Declared output of a `match_reply` node: opaque id + the text rule (no LLM). */
export const matchReplyBranchSchema = z.strictObject({
  id: declaredBranchIdSchema,
  label: z.string().min(1).max(40),
  op: z.enum(['eq', 'contains']),
  pattern: z.string().min(1).max(200),
});

export type MatchReplyBranch = z.infer<typeof matchReplyBranchSchema>;

/**
 * Where to write the contact's reply. `{{volta}}` in a custom key is replaced
 * with the current `repeat` index when the node sits inside a loop.
 */
export const replySaveToSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('contact_name') }),
  z.strictObject({
    kind: z.literal('lead_custom'),
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_{}]*$/i, 'Use letras, números, underscore ou {{volta}}'),
  }),
  // Campo personalizado do CONTATO (cadastro central, migration 0657).
  z.strictObject({
    kind: z.literal('contact_custom'),
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_{}]*$/i, 'Use letras, números, underscore ou {{volta}}'),
  }),
]);
export type ReplySaveTo = z.infer<typeof replySaveToSchema>;

/** O que fazer quando o destino de `save_to` já tem valor (captação, ficha…). */
export const ifExistsSchema = z.enum(["skip", "overwrite", "confirm"]);
export type IfExists = z.infer<typeof ifExistsSchema>;

/**
 * Teto da carência (365 dias) cobrado só na PUBLICAÇÃO: acima disso `Date`/`interval` estouram e
 * nenhum fluxo real espera tanto. Fica fora do parse de propósito — grafo já salvo com valor maior
 * continua legível (o parse estrito derrubaria todo gatilho e inscrição desse fluxo).
 */
export const GRACE_TIMEOUT_MAX_MS = 365 * 24 * 3600_000;

/**
 * Text-match node: parks in `waiting_reply` like `ai_classify`, then routes on
 * the last inbound body without calling a model. v2 `branches` only.
 */
export const matchReplyConfigSchema = z
  .strictObject({
    branches: z.array(matchReplyBranchSchema).min(1).max(8),
    grace_timeout_ms: z.number().int().min(900_000),
    save_to: replySaveToSchema.optional(),
    if_exists: ifExistsSchema.optional(),
  })
  .refine((c) => new Set(c.branches.map((b) => b.id)).size === c.branches.length, {
    message: "branches[].id must be unique within the node",
    path: ["branches"],
  });

/**
 * Repete o caminho `body` N vezes, onde N vem da última resposta do contato
 * (um número, ou palavras tipo "nenhum"/"dois"), limitado por `max_count`.
 * Estado mora nos eventos do enrollment — voltar ao nó não relê a resposta.
 */
export const repeatConfigSchema = z.strictObject({
  max_count: z.number().int().min(1).max(20),
});

/**
 * AI classification node configuration.
 * Classifies incoming messages into one of several predefined classes.
 *
 * `branches` (v2) is the source of truth for identity AND label; `classes`
 * stays the ordered class vocabulary the engine hands the LLM
 * (`engine.ts` buildClassifyPayload) and is a validated projection of it — the
 * refine below rejects any graph where the two drift, so the mirror cannot rot.
 * A node without `branches` is a v1 node: the class string is its own branch id
 * (which is exactly the rename bug — v1 nodes keep the old behaviour until the
 * builder migrates them, they just don't get stable ids for free).
 */
export const aiClassifyConfigSchema = z
  .strictObject({
    classes: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(8),
    branches: z.array(aiClassBranchSchema).min(1).max(8).optional(),
    grace_timeout_ms: z.number().int().min(900_000), // 15 min .. 365 dias
    target: z.enum(['last_reply', 'summary']).default('last_reply'),
    hint: z.string().max(500).optional(),
  })
  .refine((c) => !c.branches || new Set(c.branches.map((b) => b.id)).size === c.branches.length, {
    message: 'branches[].id must be unique within the node',
    path: ['branches'],
  })
  .refine(
    (c) =>
      !c.branches ||
      (c.branches.length === c.classes.length &&
        c.branches.every((b, i) => b.label === c.classes[i])),
    {
      message: 'classes must mirror branches[].label in the same order (branches is the source of truth)',
      path: ['classes'],
    }
  );

/**
 * Action node configuration schema.
 * - text: send this body as-is (no model)
 * - ai_message: generate a message using AI with a prompt hint
 * - template: send a canned message from Ajustes → Modelos
 */
/** Tipos de anexo que um bloco de mensagens envia — os mesmos do envio da caixa de entrada. */
export const TIPOS_DE_ANEXO = ['image', 'video', 'audio', 'document'] as const;
export type TipoDeAnexo = (typeof TIPOS_DE_ANEXO)[number];

/** 50 MB, o teto do envio de mídia (`MAX_MEDIA_BYTES`). Escrito aqui para o esquema não importar o módulo de mensagens. */
const TAMANHO_MAXIMO_DO_ANEXO = 50 * 1024 * 1024;

/**
 * Um envio dentro do bloco de mensagens: um texto OU um anexo. O anexo guarda o CAMINHO do arquivo
 * (o upload da tela devolve `{org}/flow-assets/{uuid}/{arquivo}`), nunca URL nem bytes — quem copia
 * para a pasta da conversa e assina a URL curta é o envio, como em toda mídia.
 */
export const itemDeEnvioSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    body: z.string().min(1, 'Escreva o texto ou remova este envio.').max(4000),
  }),
  z.strictObject({
    kind: z.enum(TIPOS_DE_ANEXO),
    path: z.string().min(1).max(400),
    mime: z.string().min(1).max(120),
    filename: z.string().min(1).max(200),
    size_bytes: z.number().int().positive().max(TAMANHO_MAXIMO_DO_ANEXO),
    /** Legenda (imagem, vídeo, documento). Áudio não tem legenda no WhatsApp. */
    caption: z.string().max(1024).optional(),
  }),
]);
export type ItemDeEnvio = z.infer<typeof itemDeEnvioSchema>;

/** Quantos envios cabem num bloco: acima disso é outro fluxo, e o canal estranha rajada. */
export const MAX_ITENS_DO_ENVIO = 10;

export const actionConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('text'),
    body: z.string().min(1).max(4000),
  }),
  /** Vários envios em sequência no mesmo bloco: texto, imagem, vídeo, áudio, documento. */
  z.strictObject({
    mode: z.literal('messages'),
    items: z.array(itemDeEnvioSchema).min(1, 'Adicione ao menos um envio.').max(MAX_ITENS_DO_ENVIO),
  }),
  z.strictObject({
    mode: z.literal('ai_message'),
    prompt_hint: z.string().min(1).max(1000),
    fallback_template_id: z.string().uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('template'),
    template_id: z.string().uuid(),
  }),
]);

/**
 * Internal task node configuration (#1540) — os MESMOS campos da ação de
 * automação `create_task`, de propósito: as duas portas criam a mesma tarefa,
 * e campos diferentes virariam duas telas ensinando duas verdades.
 *
 * `atribuir_a` é nominal (`dono_do_lead`) porque o fluxo é publicado sem saber
 * quem vai atender amanhã — o dono muda, o fluxo não.
 */
/** «Aplicar em» (Fase 5): uma única marca `{{nodes.<bloco>.<lead_id|contact_id>}}`; ausente = negócio/contato da execução. */
export const aplicarEmSchema = z.string().max(200).optional();

/** Os blocos de efeito que aceitam «Aplicar em» (a tela mostra o seletor; o diário resolve o alvo). */
export const NODES_COM_APLICAR_EM: ReadonlySet<string> = new Set([
  "internal_task",
  "edit_lead_tag",
  "move_lead",
  "assign_lead_owner",
  "add_note",
  "update_lead_field",
  "lead_product",
]);

export const internalTaskConfigSchema = z.strictObject({
  /** Título com `{{lead.title}}` e `{{contact.name}}`. */
  titulo: z.string().min(1).max(200),
  /** De quantos dias o prazo cai a partir do disparo. */
  vence_em_dias: z.number().int().min(0).max(365),
  atribuir_a: z.union([
    z.literal('dono_do_lead'),
    z.strictObject({ usuario_id: z.string().uuid() }),
  ]),
  prioridade: z.enum(PRIORIDADES_DA_TAREFA),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `move_lead` (#2065) — mover o card para outra etapa do MESMO funil.
 *
 * Só a etapa, sem `pipeline_id`: quem escolhe o destino é o SELETOR de etapas
 * da tela, e quem RECUSA troca de funil é a casa — `moveLeadHandler`
 * (`app/api/v1/leads/_handler`) devolve `pipeline_immutable_use_clone` quando a
 * etapa não é do funil do lead, a mesma régua do board, das automações e da
 * tool MCP. Repetir aqui a pergunta de funil seria uma segunda régua para a
 * mesma regra.
 *
 * `stage_id` aceita vazio porque o rascunho é validado SÓ estruturalmente
 * (`flowGraphSchema`) e o nó nasce sem destino — quem exige etapa escolhida é o
 * `validate-publish` (`etapa_destino_ausente`), como a condição com regra em
 * branco.
 *
 * `lost_reason` é opcional para não invalidar grafo já publicado: quem montou
 * o fluxo antes desta régua continua válido, e quem publica com destino em
 * etapa de perda precisa preenchê-lo (`motivo_da_perda_ausente`).
 */
export const moveLeadConfigSchema = z.strictObject({
  stage_id: z.string().max(64),
  lost_reason: z.string().max(500).optional(),
  won_reason: z.string().max(500).optional(),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `edit_lead_tag` (#2065) — grava tag no lead, o merge idempotente da ação
 * `add_tag` do motor de automação (`lib/automation/actions/add-tag.ts`), com os
 * MESMOS limites do schema de webhook (`lib/schemas/webhooks.ts`): até 10 tags
 * de até 60 caracteres.
 *
 * Lista vazia é rascunho em construção (mesma degradação do `stage_id`); o
 * publish recusa (`tag_ausente`) — um nó que não grava nada não pode ser
 * publicado como se gravasse.
 */
export const editLeadTagConfigSchema = z.strictObject({
  tags: z
    .array(z.string().max(60, "Tag muito longa: máximo de 60 caracteres."))
    .max(10, "No máximo 10 tags por caixa."),
  /**
   * Onde gravar. Sem a chave (ou `card`) é o negócio da inscrição. `contato` grava no contato — para
   * fluxo que etiqueta quem ainda não tem negócio; é o mesmo `destino` da ação `add_tag`.
   */
  destino: z.enum(["card", "contato"]).optional(),
  /** Fase 5 — `remove` tira as tags listadas (as outras ficam). Sem a chave: adicionar, como sempre. */
  acao: z.enum(["add", "remove"]).optional(),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `map_data` (Fase 4) — seleciona, renomeia, compõe texto e converte tipos a partir das saídas dos blocos
 * anteriores. O nome do campo é o que os blocos seguintes citam (`{{nodes.<bloco>.fields.<nome>}}`), por isso é
 * identificador simples e único no bloco. Sem campos é rascunho; o publish recusa (`mapa_sem_campos`).
 */
export const mapDataFieldSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z_][a-z0-9_]*$/, "Use letras minúsculas, números e _ (começando por letra)."),
  value: z.string().max(2000),
  type: z.enum(['text', 'number', 'boolean', 'list']),
  fallback: z.string().max(500).optional(),
});
/**
 * Nó `assign_lead_owner` (Fase 5) — troca o responsável do NEGÓCIO. Responsável pela conversa é outra coisa e não
 * muda aqui. Vazio é rascunho; o publish recusa (`responsavel_ausente`). Membro ativo e não-viewer é conferido na
 * execução, na mesma transação da escrita.
 */
export const assignLeadOwnerConfigSchema = z.strictObject({
  usuario_id: z.union([z.literal(''), z.string().uuid()]),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `add_note` (Fase 5) — nota interna no destino ESCOLHIDO: `lead_timeline` (linha do tempo do negócio) ou `conversation_notes`
 * (notas internas da conversa, que o cliente nunca vê). Texto aceita `{{nodes.<bloco>.<campo>}}`; vazio é rascunho e
 * o publish recusa (`nota_sem_texto`).
 */
export const addNoteConfigSchema = z.strictObject({
  destino: z.enum(['lead_timeline', 'conversation_notes']),
  texto: z.string().max(2000, 'Nota muito longa: máximo de 2000 caracteres.'),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `update_lead_field` (Fase 5) — grava um campo personalizado do NEGÓCIO (chave do catálogo da organização,
 * convertido pelo tipo da definição) ou o valor do negócio. O texto aceita `{{nodes.<bloco>.<campo>}}`.
 * Sem chave (campo personalizado) ou sem valor é rascunho; o publish recusa (`campo_do_negocio_incompleto`).
 */
export const updateLeadFieldConfigSchema = z.strictObject({
  // `contact_field`: campo personalizado do CONTATO (catálogo entity contact) — não precisa de negócio.
  alvo: z.enum(['custom_field', 'deal_value', 'contact_field']),
  chave: z.string().max(40),
  valor: z.string().max(2000),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `lead_product` (Fase 5) — produto do CATÁLOGO no negócio: `add` vincula (nome e preço copiados do catálogo,
 * como a rota do CRM), `remove` tira todos os itens desse produto. Sem produto é rascunho (`produto_ausente`).
 */
export const leadProductConfigSchema = z.strictObject({
  acao: z.enum(['add', 'remove']),
  product_id: z.union([z.literal(''), z.string().uuid()]),
  quantidade: z.number().int().min(1).max(10_000),
  /** Fase 5 — «Aplicar em»: `{{nodes.<bloco>.lead_id|contact_id}}` de um Buscar ou criar anterior. Vazio = o da execução. */
  aplicar_em: aplicarEmSchema,
});

/**
 * Nó `find_or_create_contact` (Fase 5) — procura um contato da organização pelo telefone (variantes do nono dígito)
 * ou e-mail; com `criar`, cria quando não acha (nome opcional). Valor e nome aceitam `{{nodes.<bloco>.<campo>}}`.
 */
export const findOrCreateContactConfigSchema = z.strictObject({
  busca: z.enum(['phone', 'email']),
  valor: z.string().max(500),
  criar: z.boolean(),
  nome: z.string().max(200),
});

/**
 * Nó `find_or_create_lead` (Fase 5) — procura o negócio ABERTO do contato no funil escolhido; com `criar`, cria na
 * etapa escolhida. `contato` vazio = o contato da execução; senão uma marca `{{nodes.<bloco>.contact_id}}`.
 */
export const findOrCreateLeadConfigSchema = z.strictObject({
  contato: z.string().max(200),
  pipeline_id: z.union([z.literal(''), z.string().uuid()]),
  stage_id: z.union([z.literal(''), z.string().uuid()]),
  titulo: z.string().max(200),
  criar: z.boolean(),
});

/** Métodos do bloco Requisição HTTP — aqui (e não em requisicao-http.ts) porque o construtor roda no navegador. */
export const METODOS_HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Nó `http_request` (Fase 5) — cita uma CONEXÃO protegida (origem + credencial cifrada, no servidor); o caminho e o
 * corpo JSON aceitam `{{nodes.<bloco>.<campo>}}`. Sem conexão é rascunho (`conexao_http_ausente`).
 */
export const httpRequestConfigSchema = z.strictObject({
  connection_id: z.union([z.literal(''), z.string().uuid()]),
  metodo: z.enum(METODOS_HTTP),
  caminho: z.string().max(2000),
  corpo: z.string().max(20_000),
});

export const mapDataConfigSchema = z.strictObject({
  fields: z.array(mapDataFieldSchema).max(30, "No máximo 30 campos por bloco."),
});

/**
 * One rule of a `condition` node. In `branching: 'per_check'` it IS a branch,
 * so it carries the stable id an edge references and the label the handle shows
 * — identity lives on the rule itself, never in a parallel array that would
 * desync the moment the user reorders the rules.
 */
export const conditionCheckSchema = z.strictObject({
  id: declaredBranchIdSchema.optional(),
  label: z.string().min(1).max(60).optional(),
  field: z.enum([
    'lead_stage',
    'tag',
    'steps_taken',
    'last_outcome',
    // Nomes dos produtos do negócio (crm_lead_products); lista, como `tag`.
    'product',
    // Fase 5 — a saída de um bloco ANTERIOR desta execução (`source` = `{{nodes.<bloco>.<caminho>}}`).
    'variavel',
  ]),
  // `exists`/`not_exists` (Fase 5): o dado tem ou não tem valor — ausente, nulo, texto vazio e lista vazia não têm.
  op: z.enum(['eq', 'neq', 'gte', 'lte', 'contains', 'exists', 'not_exists']),
  value: z.union([z.string(), z.number()]),
  /** Só com `field: 'variavel'`: a marca do dado comparado. */
  source: z.string().max(200).optional(),
});

export type ConditionCheck = z.infer<typeof conditionCheckSchema>;

/**
 * Condition node configuration.
 * Evaluates multiple checks against lead state using boolean logic.
 *
 * `branching` picks how the checks reach the canvas:
 * - `combined` (also: absent — every published v1 flow) — `combinator` folds the
 *   checks into one boolean and the node has the two fixed outputs Sim/Não.
 * - `per_check` — one output per rule, plus the mandatory fallback. `combinator`
 *   is not consulted in this mode (a rule no longer votes, it routes).
 */
export const conditionConfigSchema = z
  .strictObject({
    combinator: z.enum(['and', 'or']).default('and'),
    branching: z.enum(['combined', 'per_check']).optional(),
    checks: z.array(conditionCheckSchema).min(1).max(10),
  })
  .refine(
    (c) => {
      const ids = c.checks.flatMap((chk) => (chk.id === undefined ? [] : [chk.id]));
      return new Set(ids).size === ids.length;
    },
    { message: 'checks[].id must be unique within the node', path: ['checks'] }
  )
  .refine((c) => c.branching !== 'per_check' || c.checks.every((chk) => chk.id !== undefined), {
    message: "branching 'per_check' requires an id on every check — it is what the edge references",
    path: ['checks'],
  });

/**
 * Collect node (`collect`) — uma pergunta do fluxo de ATENDIMENTO.
 *
 * O nó NÃO envia nada sozinho: ele declara o CAMPO que precisa ser preenchido
 * (chave, rótulo, tipo) e o executor in-turn injeta a pergunta no contexto do
 * agente. Quando o valor entra (`flow_collect`, extrator ou resposta do cliente),
 * o campo deixa de ser pendente e o fluxo avança. `key` casa 1:1 com
 * `contact_flow_data.field_key` (migration 0236) — a regex espelha o CHECK do
 * banco (minúsculas, começa com letra).
 */
/**
 * `cpf` (PR 2 do port): o número confere pelo dígito verificador (mod-11 da
 * Receita) antes de ser aceito — na prova prática, um CPF com dígito errado foi
 * gravado como resposta porque o campo era "Número".
 */
export const contactFlowFieldTypeSchema = z.enum(['text', 'number', 'date', 'boolean', 'select', 'cpf']);
export type ContactFlowFieldType = z.infer<typeof contactFlowFieldTypeSchema>;

export const collectConfigSchema = z
  .strictObject({
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use letras minúsculas, números e underscore'),
    label: z.string().min(1).max(80),
    type: contactFlowFieldTypeSchema.default('text'),
    required: z.boolean().default(true),
    /**
     * Permite o cliente CORRIGIR o dado a qualquer momento: com `true` (padrão),
     * uma nova informação sobrescreve a anterior. Com `false`, o primeiro valor
     * fica travado.
     */
    permite_correcao: z.boolean().default(true),
    options: z.array(z.string().min(1).max(80)).max(20).optional(),
    /** Texto sugerido da pergunta; o agente pode reescrever (checklist guiado pela IA). */
    question: z.string().max(400).optional(),
  })
  .refine((c) => c.type !== 'select' || (c.options?.length ?? 0) > 0, {
    message: 'tipo "select" exige ao menos uma opção',
    path: ['options'],
  });

/**
 * Skill node (`skill`) — puxa uma skill instalada em paralelo ao passo do fluxo.
 * Ao entrar no nó, o executor in-turn inclui o corpo da skill no contexto do
 * turno (união com o matcher por keyword). O nome é validado contra as skills
 * instaladas no executor, não aqui (o grafo é portável entre organizações).
 */
export const skillConfigSchema = z.strictObject({
  skill_name: z.string().min(1).max(80),
});

/**
 * Ação ao finalizar um fluxo de atendimento — "quando finaliza, chama qual skill
 * ou manda pra IA". Opcional para não quebrar grafos existentes; ausente = `nada`
 * (comportamento anterior).
 */
export const endFinishSchema = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('nada') }),
  z.strictObject({ tipo: z.literal('ia'), prompt: z.string().max(1000).optional() }),
  z.strictObject({ tipo: z.literal('skill'), skill_name: z.string().min(1).max(80) }),
  /**
   * Encadeia a venda: ao concluir, o motor inicia OUTRO fluxo de atendimento
   * (`fluxo` = id do `followup_flow_pointers`). A síntese do fluxo concluído
   * (`completion_note`) entra no contexto do próximo. O id é validado em runtime
   * contra os fluxos instalados da organização (o grafo é portável) — como
   * `skill_name`. Autoencadeamento (fluxo → ele mesmo) é ignorado pelo motor.
   */
  z.strictObject({ tipo: z.literal('proximo_fluxo'), fluxo: z.string().min(1).max(80) }),
]);
export type EndFinish = z.infer<typeof endFinishSchema>;

/**
 * End node configuration.
 * Marks the conclusion of a flow with an outcome.
 */
export const endConfigSchema = z.strictObject({
  outcome: z.enum(['converted', 'exhausted', 'custom']),
  note: z.string().max(200).optional(),
  ao_finalizar: endFinishSchema.optional(),
});

/**
 * Flow node schema — discriminated union based on node type.
 * Each node type has its specific config schema.
 */
export const flowNodeSchema = z.discriminatedUnion('type', [
  // Trigger node: entry point, no config
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('trigger'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: z.strictObject({}),
  }),
  // Wait node: pauses flow for a duration
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('wait'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: waitConfigSchema,
  }),
  // Condition node: branches flow based on criteria
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('condition'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: conditionConfigSchema,
  }),
  // AI Classify node: classifies messages
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('ai_classify'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: aiClassifyConfigSchema,
  }),
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('match_reply'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: matchReplyConfigSchema,
  }),
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('repeat'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: repeatConfigSchema,
  }),
  // Collect node: uma pergunta do fluxo de atendimento (coleta um campo)
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('collect'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: collectConfigSchema,
  }),
  // Skill node: puxa uma skill instalada em paralelo ao passo
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('skill'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: skillConfigSchema,
  }),
  // Action node: sends a message
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('action'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: actionConfigSchema,
  }),
  // Internal task node (#1540): creates a CRM task, never sends a message
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('internal_task'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: internalTaskConfigSchema,
  }),
  // Nó de ação (#2065): move o card para outra etapa do funil
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('move_lead'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: moveLeadConfigSchema,
  }),
  // Nó de ação (#2065): grava tag no lead, sem mensagem
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('edit_lead_tag'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: editLeadTagConfigSchema,
  }),
  // Fase 5: produto do catálogo no negócio
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('lead_product'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: leadProductConfigSchema,
  }),
  // Fase 5: buscar ou criar contato / negócio
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('find_or_create_contact'),
    label: z.string().min(1).max(60),
    position: z.strictObject({ x: z.number(), y: z.number() }),
    config: findOrCreateContactConfigSchema,
  }),
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('find_or_create_lead'),
    label: z.string().min(1).max(60),
    position: z.strictObject({ x: z.number(), y: z.number() }),
    config: findOrCreateLeadConfigSchema,
  }),
  // Fase 5: requisição HTTP por conexão protegida
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('http_request'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: httpRequestConfigSchema,
  }),
  // Fase 5: grava campo do negócio
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('update_lead_field'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: updateLeadFieldConfigSchema,
  }),
  // Fase 5: nota interna no destino escolhido
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('add_note'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: addNoteConfigSchema,
  }),
  // Fase 5: troca o responsável do negócio
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('assign_lead_owner'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: assignLeadOwnerConfigSchema,
  }),
  // Fase 4: monta campos a partir das saídas anteriores, sem efeito
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('map_data'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: mapDataConfigSchema,
  }),
  // End node: terminal state
  z.strictObject({
    id: z.string().min(1),
    type: z.literal('end'),
    label: z.string().min(1).max(60),
    position: z.strictObject({
      x: z.number(),
      y: z.number(),
    }),
    config: endConfigSchema,
  }),
]);

export type FlowNode = z.infer<typeof flowNodeSchema>;

/**
 * Flow edge schema — connection between nodes.
 * Includes condition to determine when edge is traversed.
 *
 * `branch` is the v2 spelling: it names an output of the SOURCE node by its
 * stable id, so renaming what the user sees never detaches the edge.
 * `class_match` / `cond_result` are the v1 spellings — still valid, still
 * routed, emitted only by nodes that haven't declared branches. Which dialect
 * an edge should use is decided by the source node, not by the editor: see
 * `nodeBranches()`.
 */
export const flowEdgeSchema = z.strictObject({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  priority: z.number().int().default(0),
  condition: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('always') }),
    z.strictObject({
      type: z.literal('class_match'),
      value: z.string(), // e.g., 'hot', 'cold', 'no_reply'
    }),
    z.strictObject({
      type: z.literal('cond_result'),
      value: z.boolean(),
    }),
    z.strictObject({
      type: z.literal('branch'),
      branch_id: edgeBranchIdSchema,
    }),
  ]),
});

export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowEdgeCondition = FlowEdge['condition'];

/**
 * Configurações do fluxo (nível do grafo, não de um nó). Opcional: um grafo
 * antigo sem `settings` continua válido e cai nos defaults.
 */
export const flowSettingsSchema = z.strictObject({
  /**
   * Quantas vezes uma pergunta pode ser feita SEM resposta antes de ser
   * encerrada como não respondida (deixa de ser feita e não bloqueia a
   * conclusão). Default 3.
   */
  max_tentativas_pergunta: z.number().int().min(1).max(10).default(3),
  /**
   * Palavras/expressões que LIGAM este fluxo: quando a mensagem do cliente
   * contém uma delas, o MOTOR inicia o fluxo (entrada por gatilho, sem depender
   * do modelo). Vazio/ausente = o fluxo só começa por `flow_start` ou roteador.
   */
  gatilhos: z.array(z.string().min(1).max(60)).max(30).optional(),
  /**
   * Em quantas horas SEM mensagem do cliente o roteiro em andamento expira
   * (0397, `fn_encerrar_roteiros_vencidos`). Ausente = 72 h. Sem prazo, um
   * roteiro abandonado voltava a perguntar semanas depois (prova do #1130).
   */
  expira_em_horas: z.number().int().min(1).max(720).optional(),
  /**
   * O roteiro pode começar de novo para um cliente que JÁ o concluiu (#1130,
   * decisão do doc 69: cada roteiro escolhe). Ausente = NÃO recomeça: repetir a
   * palavra-gatilho de um cadastro já feito reabria as mesmas perguntas.
   * Agendamento, que precisa repetir, liga.
   */
  pode_recomecar: z.boolean().optional(),
  /**
   * SOMENTE INTERNO (#1540): o fluxo inteiro não fala com o cliente. A
   * publicação (`validate-publish.ts`) recusa qualquer nó de ENVIO num fluxo
   * com esta marca — é a garantia de que "só lembrete" não é uma intenção que
   * alguém esquece de conferir antes de publicar.
   */
  somente_interno: z.boolean().optional(),
});
export type FlowSettings = z.infer<typeof flowSettingsSchema>;

/**
 * Complete flow graph schema.
 * Contains nodes and edges defining the flow automation.
 *
 * O `strictObject` valida cada nó e cada aresta SOZINHOS; o `superRefine`
 * abaixo é a catraca de INTEGRIDADE entre eles. Sem ela, um grafo com aresta
 * apontando para nó inexistente ou com ids repetidos (o defeito que o #586
 * produz no canvas) passava no `safeParse` de qualquer consumidor — salvar o
 * rascunho (`draft_graph`), carregar a versão (engine, turn-bridge, enroll,
 * silence-sweep, intervenção) e publicar. A porta é a mesma para todos: quem
 * JÁ tiver rascunho corrompido recebe o erro com o id a corrigir em vez de um
 * grafo que só quebra adiante, no meio de um disparo. Sem migração de
 * rascunho — decisão registrada na issue #699.
 */
export const flowGraphSchema = z
  .strictObject({
    nodes: z.array(flowNodeSchema).min(2).max(60),
    edges: z.array(flowEdgeSchema).max(120),
    settings: flowSettingsSchema.optional(),
    /** Ausência preserva integralmente o contrato de execuções legadas. */
    execution_contract: z.literal(1).optional(),
  })
  .superRefine((grafo, ctx) => {
    const idsDeNo = new Set<string>();
    grafo.nodes.forEach((no, i) => {
      if (idsDeNo.has(no.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `id de nó repetido: "${no.id}"`,
          path: ['nodes', i],
        });
      }
      idsDeNo.add(no.id);
    });

    const idsDeAresta = new Set<string>();
    grafo.edges.forEach((aresta, i) => {
      if (idsDeAresta.has(aresta.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `id de aresta repetido: "${aresta.id}"`,
          path: ['edges', i],
        });
      }
      idsDeAresta.add(aresta.id);

      if (!idsDeNo.has(aresta.source)) {
        ctx.addIssue({
          code: 'custom',
          message: `aresta "${aresta.id}" aponta para nó inexistente: "${aresta.source}"`,
          path: ['edges', i],
        });
      }
      if (!idsDeNo.has(aresta.target)) {
        ctx.addIssue({
          code: 'custom',
          message: `aresta "${aresta.id}" aponta para nó inexistente: "${aresta.target}"`,
          path: ['edges', i],
        });
      }
    });
  });

export type FlowGraph = z.infer<typeof flowGraphSchema>;

/**
 * ---------------------------------------------------------------------------
 * Branch resolution — the single reader of the storage dialect
 * ---------------------------------------------------------------------------
 * Node configs differ per type and per version (v1 `classes: string[]` vs v2
 * `branches`, `combinator` vs `per_check`). Everything downstream — the canvas
 * handles, the edge panel, publish validation, the engine's routing — must go
 * through `nodeBranches()` and never read the raw shape, so the compatibility
 * cost is paid exactly once, here.
 *
 * ⚠️ MIGRAR UM NÓ DE v1 PARA v2 NÃO É SÓ TROCAR A CONFIG. `branchIdForCondition`
 * aceita, num nó v2, uma aresta legada `class_match` casando pelo RÓTULO — isso
 * existe para o canvas continuar desenhando um nó meio-migrado sem perder a
 * linha. O ROTEAMENTO não tem essa cortesia: `classEdgeMatch` (node-handlers)
 * devolve `{type:'branch'}` e `selectEdge` não casa a aresta antiga, caindo no
 * `always`. O resultado é tela correta com roteamento errado, e nada acusa.
 *
 * Portanto: dar `branches` a um nó que já tem arestas exige reescrever essas
 * arestas no MESMO instante — operação de canvas, atômica. É por isso que o
 * `ClassifyForm` ainda emite v1 de propósito; a ressalva está lá também.
 */

/**
 * What branch resolution actually reads off a node: its type and its config.
 * Written as a mapped union instead of `Pick<FlowNode, 'type' | 'config'>`
 * because `Pick` over a union flattens it and loses the correlation between the
 * two — and because the builder holds React Flow nodes, which have no
 * `position` in the shape this file expects. A full `FlowNode` is assignable.
 */
export type BranchableNode = {
  [K in NodeType]: Pick<Extract<FlowNode, { type: K }>, 'type' | 'config'>;
}[NodeType];

/**
 * `fallback` is the mandatory catch-all: exactly one per node, never deletable in the builder.
 * `error` is the OPTIONAL failure exit ("Fallback erro"): it needs no edge to publish.
 */
export type FlowBranchKind = 'match' | 'fallback' | 'error';

export type FlowBranch = {
  /** Stable within the node. Reserved ids are contract-owned; the rest come from the user's config. */
  id: string;
  /**
   * Text that is ALREADY decided: what the user typed (the rule's label, the
   * class name) or a fixed term of the contract. `null` on a `per_check` branch
   * the user never named — there the sentence is COMPOSED from `check`, and
   * composing pt-br out of a rule is the vocabulary's job (`vocabulario.ts`,
   * `fraseDaCondicao`), not the contract's. This file must not grow a second
   * field/operator dictionary next to that one.
   */
  label: string | null;
  /** The rule behind a `per_check` branch, so the vocabulary can phrase it. `null` on every other branch. */
  check: ConditionCheck | null;
  kind: FlowBranchKind;
  /** The condition an edge leaving through this branch must carry — canonical for THIS node's dialect. */
  condition: FlowEdgeCondition;
};

/** Nó de saída ÚNICA: a aresta sai por ali sempre, e é isso que o rótulo diz. */
const FALLBACK_ALWAYS_LABEL = 'Sempre';
/**
 * Nó que JÁ tem saídas específicas. O motor só usa esta aresta quando nenhuma
 * outra serve (`selectEdge`, node-handlers), e nunca manda o lead por duas ao
 * mesmo tempo — "Sempre" ao lado de "Interessado" e "Sem resposta" prometia
 * justamente isso, e quem montava o fluxo ligava aqui a mensagem que queria
 * mandar a todo mundo.
 */
const FALLBACK_OTHERS_LABEL = 'Outros casos';
/** O mesmo escape num nó cujas saídas são REGRAS: "o resto", dito com a palavra das regras. */
const FALLBACK_NONE_LABEL = 'Nenhuma delas';
const NO_REPLY_LABEL = 'Sem resposta';
const ON_ERROR_LABEL = 'Fallback erro';

/** Blocos que podem falhar de vez no motor novo, e por isso oferecem a saída de erro. */
export const NODES_WITH_ERROR_BRANCH: ReadonlySet<NodeType> = new Set<NodeType>([
  'action',
  'internal_task',
  'move_lead',
  'edit_lead_tag',
  'ai_classify',
  'match_reply',
  'map_data',
  'assign_lead_owner',
  'add_note',
  'update_lead_field',
  'lead_product',
  'http_request',
  'find_or_create_contact',
  'find_or_create_lead',
]);

function errorBranch(): FlowBranch {
  return {
    id: ON_ERROR_BRANCH_ID,
    label: ON_ERROR_LABEL,
    check: null,
    kind: 'error',
    condition: { type: 'branch', branch_id: ON_ERROR_BRANCH_ID },
  };
}

function fallbackBranch(label: string): FlowBranch {
  return {
    id: FALLBACK_BRANCH_ID,
    label,
    check: null,
    kind: 'fallback',
    condition: { type: 'always' },
  };
}

/**
 * Every output of `node`, in the order the builder should draw the handles,
 * with the mandatory fallback last. A v1 node yields v1 conditions and a v2
 * node yields `branch` conditions — a published flow is never rewritten just
 * because the contract grew.
 */
export function nodeBranches(node: BranchableNode): FlowBranch[] {
  switch (node.type) {
    case 'condition': {
      if (node.config.branching === 'per_check') {
        const branches: FlowBranch[] = node.config.checks.flatMap((check) =>
          check.id === undefined
            ? [] // unreachable for a parsed config: 'per_check' refines every check to have an id
            : [
                {
                  id: check.id,
                  label: check.label ?? null, // null: o vocabulário monta a frase a partir de `check`
                  check,
                  kind: 'match' as const,
                  condition: { type: 'branch' as const, branch_id: check.id },
                },
              ]
        );
        return [...branches, fallbackBranch(FALLBACK_NONE_LABEL)];
      }
      return [
        {
          id: CONDITION_TRUE_BRANCH_ID,
          label: 'Sim',
          check: null,
          kind: 'match',
          condition: { type: 'cond_result', value: true },
        },
        {
          id: CONDITION_FALSE_BRANCH_ID,
          label: 'Não',
          check: null,
          kind: 'match',
          condition: { type: 'cond_result', value: false },
        },
        fallbackBranch(FALLBACK_OTHERS_LABEL),
      ];
    }

    case 'ai_classify': {
      const declared = node.config.branches;
      const classBranches: FlowBranch[] = declared
        ? declared.map((b) => ({
            id: b.id,
            label: b.label,
            check: null,
            kind: 'match' as const,
            condition: { type: 'branch' as const, branch_id: b.id },
          }))
        : node.config.classes.map((cls) => ({
            id: cls, // v1: the class string is its own branch id
            label: cls,
            check: null,
            kind: 'match' as const,
            condition: { type: 'class_match' as const, value: cls },
          }));
      return [
        ...classBranches,
        {
          id: NO_REPLY_BRANCH_ID,
          label: NO_REPLY_LABEL,
          check: null,
          kind: 'match',
          condition: declared
            ? { type: 'branch', branch_id: NO_REPLY_BRANCH_ID }
            : { type: 'class_match', value: NO_REPLY_BRANCH_ID },
        },
        errorBranch(),
        fallbackBranch(FALLBACK_OTHERS_LABEL),
      ];
    }

    case 'match_reply': {
      const classBranches: FlowBranch[] = node.config.branches.map((b) => ({
        id: b.id,
        label: b.label,
        check: null,
        kind: 'match' as const,
        condition: { type: 'branch' as const, branch_id: b.id },
      }));
      return [
        ...classBranches,
        {
          id: NO_REPLY_BRANCH_ID,
          label: NO_REPLY_LABEL,
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: NO_REPLY_BRANCH_ID },
        },
        errorBranch(),
        fallbackBranch(FALLBACK_OTHERS_LABEL),
      ];
    }

    case 'repeat':
      return [
        {
          id: REPEAT_BODY_BRANCH_ID,
          label: 'Próxima volta',
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: REPEAT_BODY_BRANCH_ID },
        },
        {
          id: REPEAT_DONE_BRANCH_ID,
          label: 'Acabou',
          check: null,
          kind: 'match',
          condition: { type: 'branch', branch_id: REPEAT_DONE_BRANCH_ID },
        },
        fallbackBranch(FALLBACK_OTHERS_LABEL),
      ];

    default:
      return NODES_WITH_ERROR_BRANCH.has(node.type)
        ? [errorBranch(), fallbackBranch(FALLBACK_ALWAYS_LABEL)]
        : [fallbackBranch(FALLBACK_ALWAYS_LABEL)];
  }
}

/**
 * As saídas que dão FORMA ao cartão do nó (altura, corredor lateral, frase da aresta). Num nó de
 * saída única, "Fallback erro" é só uma bolinha a mais ao lado — o cartão continua um nó simples e
 * o fio normal continua saindo pelo rodapé. Nos nós que já têm linhas de saída ele é mais uma linha.
 */
export function branchesForShape(node: BranchableNode): FlowBranch[] {
  const all = nodeBranches(node);
  return all.length === 2 && all[0]?.kind === 'error' ? all.slice(1) : all;
}

/**
 * Which branch of `source` an edge condition serves, or `null` when it names
 * nothing on that node (a rule deleted while an edge still pointed at it —
 * publish validation's job to surface, not the parser's: rejecting it at parse
 * time would make a half-built draft unsaveable).
 * Accepts both dialects so a v2 node that still carries a leftover v1 edge
 * resolves instead of silently losing its route.
 */
export function branchIdForCondition(
  source: BranchableNode | undefined,
  condition: FlowEdgeCondition
): string | null {
  if (condition.type === 'always') return FALLBACK_BRANCH_ID;
  if (source === undefined) {
    return condition.type === 'branch'
      ? condition.branch_id
      : condition.type === 'class_match'
        ? condition.value
        : condition.value
          ? CONDITION_TRUE_BRANCH_ID
          : CONDITION_FALSE_BRANCH_ID;
  }

  const branches = nodeBranches(source);
  if (condition.type === 'branch') {
    return branches.some((b) => b.id === condition.branch_id) ? condition.branch_id : null;
  }
  if (condition.type === 'class_match') {
    // v1 spelling: the value is the branch id on a v1 node and the LABEL on a v2 one.
    const byId = branches.find((b) => b.id === condition.value);
    if (byId) return byId.id;
    const byLabel = branches.find((b) => b.kind === 'match' && b.label === condition.value);
    return byLabel?.id ?? null;
  }
  const id = condition.value ? CONDITION_TRUE_BRANCH_ID : CONDITION_FALSE_BRANCH_ID;
  return branches.some((b) => b.id === id) ? id : null;
}

/** The condition an edge must carry to leave `node` through `branchId` — `null` if no such branch. */
export function conditionForBranch(node: BranchableNode, branchId: string): FlowEdgeCondition | null {
  return nodeBranches(node).find((b) => b.id === branchId)?.condition ?? null;
}
