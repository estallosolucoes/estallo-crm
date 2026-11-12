# Inbox e pipeline — revisão de leitura e situação de resposta

Destino: núcleo. As categorias e os cards são parte da operação comum, sem configuração de extensão.

O campo calculado `status_do_chat(conversations)` compara os carimbos já mantidos pela ingestão e pelo envio. A migration 0663 e o apêndice do baseline devem ser aplicados junto com o aplicativo. A leitura é SECURITY INVOKER e preserva as políticas de visibilidade; nenhum atendimento é alterado pela classificação.

Living System Checklist:

- Entrada: `conversations.last_inbound_at/last_outbound_at`, status e grupo; no funil, `crm_leads.tags` e os dados de contato já lidos pelo board.
- Saída: `conversations/_handler.ts` e `counts/route.ts` alimentam `InboxFilters` e `ConversationList`; `board/route.ts` alimenta `KanbanCard`.
- Registro: a classificação é leitura pura. Adicionar lead continua por `NewLeadDialog` → `useCreateLead`, com a auditoria e os eventos da rota de criação existente.
- Tela e porta: `/app/inbox` e `/app/pipelines/[id]`, já presentes no catálogo de navegação.
- Próximo passo: Sem resposta e Em espera mostram quem precisa de retorno; o atalho da conversa no card leva ao Inbox. Etapa vazia abre o formulário com a etapa definida.
- Configuração: categorias são fixas; canal e ordem ficam no popover do Inbox, com chips removíveis. Nome/cor da etapa e etiquetas seguem seus cadastros.
- Continuidade: a mudança só apresenta os carimbos e os dados; preserva o responsável humano/IA, as ações de handoff e os mecanismos de follow-up.
- Retorno: não há decisão automatizada nova. Realtime invalida lista e contadores após mensagens; testes cobrem os predicados e a navegação entre categorias.
- Mapa: `docs/architecture/inbox-status-resposta.architecture.json`.

Aceite visual: cinco categorias sem sobreposição; ajuda curta; filtro por instância e ordem nos dois sentidos; mensagens legíveis em tema escuro; cards com foto ou iniciais, etiquetas, valor, menu visível e canal verdadeiro; estado vazio abrindo a etapa correta; mobile sem estouro horizontal. A prova do backend usa o baseline local e os invariantes de visibilidade existentes.

Validação local em 17/10/2026:

- Build de produção com Turbopack e `pnpm typecheck` concluídos. Lint completo sem erros; o recorte final dos arquivos alterados tem três avisos, sem erros. `lint:channels`, `lint:role-rank` e conferência do fragmento de release passaram.
- Testes unitários afetados passaram, incluindo ordem e filtros, ajuda, remoção da posição, divisórias, menu do card e etapa inicial do formulário. O piso da lista no desktop é 420px; larguras antigas salvas são ajustadas na leitura.
- `pnpm test:db tests/invariants/status-de-resposta-do-chat.test.ts tests/invariants/gov-5b-inbox-scope-counts.test.ts`: dois arquivos, nove testes aprovados. O harness aplicou o baseline em banco novo, reaplicou sem erros e verificou o isolamento da atualização. A conferência de release usou a tag upstream v1.84.0, pois o fork não publica releases.
- Playwright com Chrome, app buildado e Supabase local isolado: categorias e contagens nos quatro cenários de mensagem, filtro pela instância, ordenação nos dois sentidos, modal de ajuda, contraste calculado dos balões, largura mínima e cards/etapa vazia aprovados. O botão da etapa abriu o formulário com a etapa correta. Capturas nos dois temas e em 390px, sem transbordamento horizontal do documento.
- Regressão adicional: os dez casos de `contadores-do-menu`, `inbox-quem-manda`, `inbox-scope` e `queue-assign` passaram em execuções direcionadas. Os testes foram alinhados aos controles atuais: expandir o grupo da IA, abrir a ficha antes de conferir Atividade e abrir Mais ações para devolver ao automático. Escopo entre organizações, ID inválido, atribuição e continuidade humano/IA continuam cobertos. Tarefas foi fotografada após concluir a carga, nos dois temas.
- Contraste medido: saída com fundo `rgb(8, 90, 127)` e texto branco; entrada com texto `rgb(248, 250, 251)`; prévia da lista em 14px. Acentos de texto no escuro usam `#8FD9F5`, separados do fundo de ação.

Capturas com dados sintéticos em `evidence/ux-status-pipeline/`: Inbox, ajuda, filtros, pipeline, formulário da etapa, versões mobile e Contatos/Tarefas nos dois temas. Foto usa a rota privada já existente; na ausência de arquivo, o card mostra as iniciais do contato. Nenhum envio externo de WhatsApp ou chamada de IA foi necessário para este aceite.

Limites: a revisão global aplica os tokens e componentes compartilhados; a inspeção visual cobre as telas citadas, não cada rota do produto. A suíte unitária completa foi tentada e interrompida após falhas em cercas de governança e scripts; não é reportada como aprovada. GitHub Actions e publicação não foram executados. A migration 0663 acompanha o aplicativo e precisa ser aplicada no ambiente de destino.
