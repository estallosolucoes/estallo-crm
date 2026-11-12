# Motor antigo × motor novo (contrato 1) — comparação bloco a bloco

Data: 2026-10-29. Método: LEITURA do código (`engine.ts`, `node-handlers.ts`, `turn-bridge.ts`,
`execution-journal-pg.ts`). Nenhum comportamento foi executado lado a lado nesta rodada.
Pergunta que responde: o motor novo faz tudo que o antigo fazia?

## Como os dois se relacionam

- **A decisão é uma só.** `node-handlers.ts` decide o que cada bloco quer fazer (avançar, esperar,
  enfileirar turno, completar). Os dois motores chamam essa mesma decisão para gatilho, espera,
  condição, repetir, classificar com IA, captar resposta e fim.
- **Muda a camada de efeito.** O antigo grava o evento, aplica o efeito e atualiza a inscrição em
  passos separados e **tolera falha** (avisa no log e segue). O novo registra tentativa, efeito e
  avanço na **mesma transação** e **falha fechado** (a etapa fica com erro, abre aviso na Central, e
  a inscrição não avança).

## Diferenças de comportamento (por bloco)

| Bloco | Antigo | Novo | Avaliação |
|---|---|---|---|
| Gatilho, espera, condição, repetir, fim | Decisão em `node-handlers.ts` | Mesma decisão; avanço registrado no diário | Igual na decisão |
| Classificar com IA | Turno enfileirado; conclui gravando evento | Turno ligado à tentativa; reaproveita tentativa em voo (janela e limites) | Mais seguro; sem diferença de resultado esperada |
| Captar resposta (`match_reply`) | Avança primeiro e grava o campo depois; **se a gravação falha, o fluxo já avançou** (só log) | Grava o campo e avança na **mesma transação** | **Diferente**: o novo não perde a resposta em silêncio |
| `match_reply` com confirmação | Pergunta pelo turno; qualquer resposta depois do envio vale | Resposta só vale **depois do aceite** da pergunta; pergunta na fila por horas não perde a janela | **Diferente** (deliberado; limitação registrada: resposta enviada com a pergunta ainda na fila não conta) |
| Tarefa interna | Falha ao criar → só log, **o fluxo avança** | Falha → etapa em erro + aviso, **não avança**. Lead explícito; sem lead, a tarefa exige dono real | **Diferente**: novo é mais rígido |
| Mover lead | Escolhe o negócio mais recente **no funil da etapa**; contato sem negócio no funil → pula e avança. Usa o escritor de etapa da casa (`moveLeadHandler`) | Exige o **lead explícito** da inscrição; sem lead → erro `execution_lead_required`. Calcula a posição (`max + 1000`) e valida motivo de perda/ganho dentro da transação | **Diferente**: (1) sem lead falha em vez de pular; (2) caminho de escrita reimplementado — **não provei que é equivalente** ao `moveLeadHandler` em todos os casos (posição, eventos) |
| Editar tag | Mesma ação `add_tag` do motor de automação; **sem negócio grava no contato** | Exige o lead explícito; sem lead → erro. Emite `lead.tag_added`, atividade e auditoria dentro da transação | **Diferente**: o novo não grava tag em contato sem lead |
| Ação (envio de mensagem) | Enfileira turno; "at-most-once" por `source_step_key` | Mesma regra + recibo do ledger de envio; incerto → revisão na Central, nunca reenvio | Equivalente ou mais seguro |
| Espera inteligente | Plano de espera decidido pelo gatilho | Plano gravado por `completePlan` no diário | Equivalente (testado no recorte) |
| `collect`, `skill` | Passagem no relógio; o trabalho é do executor de atendimento (`atendimento.ts`) | **Recusados na publicação** (`execution_node_not_integrated`) | Não é regressão: pertencem ao atendimento, que não usa o diário |

## Resumo

- **Cobertura de tipos:** 11 dos 13 tipos estão no motor novo. Os 2 de fora (`collect`, `skill`)
  são do atendimento.
- **Resultado igual?** Não em tudo. As diferenças acima são, em sua maioria, o motor novo **recusando
  em vez de pular ou gravar errado** (sem lead explícito, falha de gravação, resposta anterior à
  pergunta). Isso é intencional, mas muda o que um fluxo antigo faria.
- **O ponto de maior risco real:** `move_lead`. O caminho do novo é uma reimplementação em SQL, e o
  antigo reaproveita o escritor de etapa usado por board, lote, automações e MCP. Merece teste
  comparando os dois no mesmo cenário (posição no funil, reabertura de negócio, troca de funil,
  eventos emitidos) antes de aposentar o antigo.

## Não medido

- Execução lado a lado dos dois motores sobre os mesmos cenários.
- Equivalência de `completeMove`/`completeTags`/`completeTask` com `moveLeadHandler`, `add_tag` e
  `criarTarefaNoCrm` (só lidos, não comparados por teste).
- Eventos da linha do tempo da inscrição (tipos e textos) entre os dois motores.

## Atualização 2026-10-29 — "Fallback erro" (decisão do dono)

A diferença mais cara da tabela (falha de gravação) ganhou saída própria: cada bloco que pode falhar no
motor novo (`action`, `internal_task`, `move_lead`, `edit_lead_tag`, `ai_classify`, `match_reply`) tem a
saída **"Fallback erro"** (`branch: on_error`). Ligada a um nó, a falha **definitiva e conhecida** desvia o
fluxo para ele na mesma transação (evento `execution_error_routed`, sem aviso na Central). Sem a aresta,
nada muda: para a inscrição e avisa a Central. Resultado `unknown` nunca desvia. Falha transitória tenta de
novo primeiro e só desvia ao esgotar as tentativas. Detalhes e provas: entrada de 2026-10-29 no
`HANDOFF-automacoes-crm.md`.

## Atualização 2026-10-29 — MOVER LEAD medido lado a lado

`tests/invariants/automacoes-mover-lead-antigo-x-novo.test.ts` (10 cenários; roda só com o Supabase
local de pé, senão se pula): cada cenário cria dois negócios idênticos em funis próprios, move um pelo
`moverLeadNoFunil` do motor antigo (REST + `moveLeadHandler`) e o outro pelo `completeMove` do novo, e
compara o que ficou no banco.

| Cenário | Resultado |
|---|---|
| aberta → aberta | **Igual**: etapa, posição (`max+1000`), status, atividade (tipo e texto), `actor_kind` |
| evento e auditoria | **Igual**: `lead.stage_changed` e `lead.moved` nos dois |
| → perda com motivo / sem motivo | **Igual**: ambos gravam; sem motivo ambos recusam (`lost_reason_required`) |
| reabrir negócio perdido | **Igual** |
| já está na etapa de destino | **Igual** (mesma posição, 1 atividade) |
| → ganho sem motivo | **Igual** |
| **→ ganho com "motivo do ganho" no bloco** | **Diverge**: o antigo **ignora** `won_reason` (só repassa `lost_reason`); o novo grava. O novo faz o que o bloco diz. |
| **etapa de outro funil** | **Diverge**: o antigo **não move e segue o fluxo sem erro** (só log `sem_negocio_no_funil`); o novo **recusa** (`pipeline_immutable_use_clone`) → com "Fallback erro" o fluxo pode seguir por ele |
| contato pessoal | Nenhum move. Antigo: `forbidden` (engolido, o fluxo avança); novo: inscrição obsoleta (para) |

**Conclusão:** no caminho feliz e nas regras de perda/reabertura o novo é equivalente ao antigo. As duas
divergências reais favorecem o novo (grava o que o bloco promete; não finge que moveu). O ponto de
risco deixa de ser "reimplementação diferente" e passa a ser "o antigo seguia em silêncio": um fluxo que
dependia de passar por um `move_lead` que não movia agora falha — e é exatamente para isso que existe o
"Fallback erro".

**Como rodar:** com o Supabase local de pé (`estallo-automacoes-local`), `REST_URL`, `REST_SERVICE_KEY`
(da `.env.e2e`), `TEST_DB_CONTAINER=supabase_db_estallo-automacoes-local`, `TEST_DB_PORT=55322` e uma
config vitest com `include` só deste arquivo e `alias @`.

**Ainda NÃO medido:** eventos da linha do tempo da inscrição entre os dois motores (`edit_lead_tag` e
`internal_task` foram medidos na seção seguinte).

## Atualização 2026-10-29 — EDITAR TAG e TAREFA INTERNA medidos lado a lado

`tests/invariants/automacoes-tag-e-tarefa-antigo-x-novo.test.ts` (12 cenários, mesmo método do mover lead;
roda só com o Supabase local de pé, senão se pula): 12/12 contra o Supabase local.

| Bloco / cenário | Resultado |
|---|---|
| Tag nova em negócio sem tags | **Igual**: mesmas tags, mesmo evento `lead.tag_added` |
| Tags existentes + mistura de repetida e nova | **Igual**: merge idempotente, nada apagado |
| Tag que o negócio já tem | **Igual**: não muda nada, não emite evento |
| Atividade e auditoria da edição | **Novo faz mais**: grava `lead_edited` na linha do tempo e `lead.updated` na auditoria; o antigo (ação `add_tag`) não grava nenhum dos dois |
| **Tag em contato SEM negócio** | **Diverge**: o antigo grava a tag no contato (`contact.tag_added`); o novo recusa (`execution_lead_required`) |
| Tarefa com dono do negócio | **Igual**: título, prioridade, responsável, prazo, vínculos, atividade `task_created` e auditoria `crm_task.created` |
| Título com `{{lead.title}}`/`{{contact.name}}` | **Igual** |
| Responsável escolhido na regra | **Igual** |
| Contato sem negócio + responsável escolhido | **Igual** (a tarefa nasce ligada ao contato nos dois) |
| **Negócio sem dono** + "dono do negócio" | Nenhuma tarefa nos dois. O antigo segue calado (só log, o fluxo avança); o novo recusa (`sem_dono`) |
| **Responsável que não é da organização** | Nenhuma tarefa nos dois. O antigo segue calado; o novo recusa (`task_assignee_unavailable`) |

**Conclusão:** tarefa interna é equivalente nos casos em que ambos criam; nos que nenhum cria, a única
diferença é o antigo calar e o novo falhar de forma visível (com "Fallback erro" o fluxo segue). A única
divergência real de dado é **tag em contato sem negócio**: o novo não faz. Antes de aposentar o antigo,
decidir se isso importa. Saídas possíveis: o bloco aceitar destino "contato" (a ação `add_tag` já aceita
`config.destino`) ou o fluxo garantir um negócio antes.
