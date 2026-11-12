# Contrato de Automações do CRM

Estado: em implementação. Referência de escopo: [plano por fases](../superpowers/plans/2026-10-18-automacoes-crm.md). Progresso e evidências: [handoff](../handoffs/HANDOFF-automacoes-crm.md).

## Compatibilidade e catálogo

O grafo existente continua válido sem inclusão automática de campos. `execution_contract: 1` identifica o contrato de execução inspecionável; sua ausência mantém o contrato legado. O campo deve sobreviver a edição, persistência, cópia e transporte. Acrescentar o marcador a um grafo não pode habilitar um executor sem implementação.

O catálogo em `lib/followup/node-catalog.ts` é a fonte de nomes, categorias, descrição, palavras de busca, superfícies e natureza de efeito dos nós. A lista oferecida pela paleta e a aceitação da publicação vêm da mesma origem. Contratos de configuração continuam definidos no grafo discriminado; o catálogo não mantém uma segunda versão deles.

`lib/followup/node-output-contracts.ts` declara as saídas do contrato 1 para os onze tipos usados em follow-up/automação. O catálogo referencia esses schemas e sua versão. A representação JSON Schema é derivada de Zod, sem duplicar o contrato ou incluir amostras de clientes. São contratos preparados para integração; o motor legado não passa a emitir esses outputs por causa desta declaração. `collect` e `skill`, exclusivos de atendimento, mantêm contrato de saída indisponível até sua instrumentação própria.

Saídas comerciais exigem identificadores reais: tarefa criada, lead e etapas da movimentação, tags resultantes e mensagens aceitas. Aceitação não afirma entrega/leitura. Classificação sem resposta é distinguida de classe produzida pela IA; repetições recusam índices impossíveis. Os refinamentos de domínio continuam sendo verificados pelo schema Zod em runtime, além da descrição estrutural JSON Schema.

## Identidades e resultados

Execução reutiliza a inscrição existente e fixa organização, versão, contato, lead explícito quando necessário e origem. Passagem é uma visita lógica ao nó; rechecagem de relógio não cria nova passagem. Tentativa representa processamento dessa passagem. Efeito identifica a ação concreta e permanece estável entre tentativas de recuperação, sem confundir reinício intencional com repetição de worker.

Status técnico e desfecho comercial são campos separados. Resultado desconhecido não equivale a falha segura para reenvio. Sucesso exige efeito confirmado. Resultados de nós carregam dados JSON tipados e metadados de tentativa separados.

Detalhes adicionais de persistência, endpoints e comportamento são acrescentados nesta especificação à medida que cada fase é implementada e validada. Este documento não declara que recursos planejados já existem.

## Persistência preparada na migration 0698

- `followup_enrollments`: campos aditivos `execution_contract` (default 0 legado), `execution_mode`, `lead_id`, `source_enrollment_id` e `recovery_kind`.
- `followup_execution_steps`: uma passagem por execução/nó/visita; estado, iteração, timestamps, ramo e vínculo com passagem herdada.
- `followup_execution_attempts`: número de tentativa único por passagem, snapshots de entrada/configuração/saída/erro, timestamps e indicação explícita de saída registrada. Essa indicação distingue saída JSON null de dado não registrado.
- `followup_execution_effects`: chave única de efeito por organização, passagem, operação, estado, resultado e referência externa.
- FKs compostas impedem misturar tenants, vincular lead de outro contato, trocar o contato da execução original numa recuperação e registrar efeito numa passagem de outra execução. Passagens são legíveis por membros autorizados; snapshots/efeitos exigem manager+. Sessões autenticadas não escrevem nessas tabelas, inclusive manager.

A migration e o apêndice foram aplicados em ambiente local: instalação/reaplicação do baseline e atualização com dados passaram. Tipos regenerados e typecheck completo passaram. A suíte ampla aprovou 442 arquivos e revelou três falhas em dois arquivos; os cenários afetados passaram após as correções, numa rodada de 139 testes. A suíte inteira não foi repetida após a correção pontual; detalhes e limites no handoff. A integração iniciou pelo nó Criar tarefa, descrito abaixo. O contrato novo continua indisponível para publicação.

## Fase 2 — alvo explícito em integração

`execution-lead.ts` centraliza a escolha de lead nos fatos, renderização e escritores existentes de tarefa, movimentação e tag. No contrato 1, `lead_id` vem da inscrição: a consulta filtra organização, contato e ID; alvo indisponível é erro e não permite buscar outro lead. Um `lead_id: null` explícito não consulta leads. O filtro de funil da movimentação e a seleção por atualização continuam restritos ao contrato legado.

O motor confere a concordância entre o contrato do grafo e da inscrição antes de processar o nó. Contrato incompatível ou ainda indisponível interrompe a execução e usa o aviso operacional existente; não cai silenciosamente no executor legado. A gravação de tentativas e a confirmação transacional estão integradas aos nós descritos abaixo; recibos de envio e os demais nós seguem pendentes. Esta preparação não habilita o contrato novo.

A conclusão assíncrona em `turn-bridge.ts` aplica a mesma verificação de contrato antes de gravar avanço. Seu adapter Postgres preserva `execution_contract` e `lead_id` ao mapear a inscrição. `execution-lead-pg.ts` também fixa o mesmo alvo nos fatos e no contexto de renderização usado pelo worker, sem fallback entre Leads. Esses leitores foram exercitados contra Postgres real, com dois Leads do mesmo contato, alvo ausente e referências fora da organização/contato.

`lib/automation/execution-capability.ts` mantém a capacidade compartilhada entre publicação, cron, conclusão assíncrona e envio. O worker consulta o contrato da inscrição e de sua versão fixada antes de chegar à cadeia de envio; o atalho inline faz a mesma validação antes da elegibilidade, janela e diário de envio. Divergência ou contrato indisponível falha antes da mensagem. Não se confia em um marcador no payload do job para essa decisão.

Ainda falta propagar o Lead na preparação efetiva dos turnos de IA/modelos e completar a persistência transacional dos demais nós. Portanto o contrato continua indisponível, inclusive para publicação. Os testes de bloqueio do envio usam a cadeia substituída por spies: não comprovam entrega por um canal real nem recuperação após crash.

## Diário transacional — integração inicial do nó Criar tarefa

`execution-journal.ts` define a porta de persistência consumida pelo motor existente; `execution-journal-pg.ts` usa um único PoolClient por transação curta. O adapter Supabase resolve o pool canônico sob demanda; o worker reutiliza o pool que já possui. O nó Criar tarefa do contrato 1 chama a porta antes do caminho legado. A disponibilidade pública continua bloqueada; os testes de integração liberam apenas esse bloqueio em um seam explícito.

- `begin` grava passagem e tentativa, leituras de contato/Lead, configuração da versão fixada e parâmetros de tarefa resolvidos antes da criação. Repetição do mesmo begin/lease retorna a mesma tentativa. Leituras históricas não são substituídas por dados atuais na conclusão.
- A preparação de tarefa e de atividade é compartilhada com os escritores canônicos em `lib/tarefas/criar-tarefa.ts` e `lib/tarefas/atividade.ts`. A transação confirma tarefa, atividade no Lead, recibo de efeito, output validado, estado da passagem/tentativa e avanço com o evento existente. Push ocorre após commit; auditoria é best effort e usa SAVEPOINT para não desfazer o trabalho por falha de log.
- Organização, contato, Lead, versão, nó, revisão, lease, fronteira de atendimento e proteção de agenda são conferidos na escrita. O alvo de atribuição deve continuar sendo membro aceito da organização. Worker obsoleto, pausa e cancelamento não criam tarefa nem avançam a execução.
- Revisão capturada e prazo do lease são metadados separados na tentativa. Reclaim interrompe a tentativa anterior e abre outra na mesma passagem. Existência de efeito ainda não reconciliado encerra a passagem como desconhecida e abre aviso na Central, em vez de repetir o efeito. O número de tentativas limita também interrupções de worker.
- Repetir a conclusão após commit devolve o recibo confirmado sem nova tarefa, atividade ou avanço. A chave de efeito desta integração ainda usa a própria execução; o compartilhamento da identidade nas recuperações de linhagem será integrado antes de liberar a recuperação na fase 6.
- Falhas de configuração ficam registradas na tentativa, interrompem a execução e abrem aviso operacional na Central. Falhas transitórias usam o backoff existente, sem transformar falha em sucesso.

Migration 0704 acrescenta `lease_revision`/`lease_until` e impede alterar a origem do contrato 1 (organização, contato, Lead, versão, modo, linhagem e fronteira). Também recusa converter uma inscrição legada em contrato novo no lugar: a transição cria uma execução nova. Foi aplicada somente na stack local isolada, e os tipos foram regenerados do banco. Não editar a migration já aplicada.

Condição, Acionamento sem planejamento de IA e Encerrar fluxo também usam o diário. O handler puro fornece a aresta e o ramo no ponto da decisão; condição registra os checks avaliados, inclusive a precedência no modo por regra e o fallback efetivamente percorrido. O diário persiste output/ramo/aresta e avanço na mesma transação, sem inventar um efeito de CRM para uma decisão pura. Uma tentativa reutilizada consome os fatos congelados do input registrado. O encerramento conserva o aviso de recuperação de falta, escrito por SQL compartilhado com o adapter PG e protegido contra anonimização.

Tags e Mover Lead também confirmam a mutação, atividade, evento, recibo e avanço na mesma transação. A preparação comercial é compartilhada com os escritores canônicos; a movimentação respeita campos obrigatórios, reabertura e motivo de encerramento. Mudanças concorrentes no Lead ou nas regras do funil recusam o snapshot antigo antes da escrita. Foram validados concorrência, rollback e recusas comerciais em Postgres local.

Aguardar está em integração: uma passagem/tentativa permanece `waiting`, com `next_eval_at` durável. Retomar atualiza o lease da tentativa existente; rechecagens não contam como novas visitas. O output informa o agendamento original e a retomada; prazo null significa que uma resposta dispensou a espera antes de agendar. Falha transitória preserva o prazo na próxima tentativa.

Integração ainda incompleta: provas finais das esperas, repetição, captura de resposta e envio/IA. A detecção de efeito incerto não constitui uma interface de reconciliação pronta. O rollback testado por exceção SQL antes do commit e a repetição após ignorar uma resposta não equivalem a teste de SIGKILL ou perda real de conexão durante COMMIT.

## Retenção, anonimização e configuração

Implementação presente na mesma migration, aplicada somente em banco local de teste:

- Política em `organizations.settings.automations.retention`: padrão de 30 dias para payload e 180 para metadados; payload entre 1–365 dias e metadados entre 30–1825, nunca menores que o prazo do payload. Configuração inválida utiliza o padrão inteiro e informa `configuration_valid: false`.
- O cron existente de retenção chama `fn_expurgar_payloads_de_automacao` e `fn_expurgar_execucoes_de_automacao`. Contagens são de execuções; cada dreno reporta lotes/resto e falha isoladamente. Qualquer efeito ou falha é auditado pelo caminho já existente.
- Expurgo por prazo só alcança contrato 1 e execuções terminais, contado a partir de `completed_at`. A linhagem de execuções vivas e passagens herdadas protege os dados necessários à continuação. A limpeza de metadados respeita FKs e drena filhos antes dos pais.
- `payload_expired_at` distingue dado expurgado de saída JSON null. A anonimização do contato limpa tentativas e efeitos; um trigger em escritas posteriores consulta o contato com trava para impedir que uma gravação tardia ressuscite o conteúdo. A marca de expiração é permanente, inclusive após expurgo por prazo: callbacks não podem removê-la nem repor snapshots ou recibos.
- Gestores chegam à configuração por **Retenção do histórico**, na lista de fluxos. O formulário mantém valores se a escrita falhar, separa caches por empresa e mostra que fluxos antigos preservam seu histórico existente.
- `GET/PATCH /api/v1/ai/followup-flows/retention` exige manager+. PATCH exige os dois prazos, recusa organização no body e aplica `requireSupportWrite` antes do efeito. O RPC de gravação é exclusivo de service role, bloqueia a organização e preserva as demais configurações. A mutação emite `followup.retention_updated`.

A validação adicional isolada em PGlite possui evidência com hash da migration em `docs/testing/automacoes-fundacao-pglite.json`. Não substitui baseline completo, PostgREST, concorrência ou prova visual. Os invariantes de Docker e a jornada Playwright da retenção passaram localmente; resultados e limites estão no handoff. O E2E de retenção não valida o executor novo.
