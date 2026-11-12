# Automações do CRM — plano de implementação e homologação local

Data: 18/10/2026. Estado: plano de referência; fundação em implementação, sem homologação completa. O progresso e as evidências locais estão em [HANDOFF-automacoes-crm.md](../../handoffs/HANDOFF-automacoes-crm.md). As fases abaixo descrevem o escopo e seus critérios de aceite, não funcionalidades já entregues.

## 1. Objetivo e decisões do produto

Evoluir Follow-ups para Automações do CRM, com categorias de nós, ações comerciais, histórico de execuções, canvas que espelha cada execução, inspeção de entrada/saída, variáveis entre etapas, reexecução e exportação/importação JSON. A experiência se inspira nos exemplos apresentados pelo proprietário e em mecanismos do n8n; o motor continua nativo do Estallo.

Decisões confirmadas:

- Usar **Lead** em todas as telas, nós, documentação e mensagens. Contato e lead são entidades diferentes; um contato pode ter vários leads.
- Priorizar vendas e funil, mantendo follow-up como caso de uso e preservando atendimento e pós-venda existentes.
- Oferecer recuperação do ponto de falha e nova execução desde o início.
- Exportar e importar entre organizações, com remapeamento de dependências.
- Preparar contratos para objetos e listas; entregar primeiro jornadas individuais. Busca em lote, iteração de listas e paralelismo ficam fora desta entrega.
- Implementar e homologar exclusivamente em ambiente local. Não executar GitHub Actions, deploy, publicação de imagens, comandos na VPS ou migrations em banco remoto. Builds e contêineres de teste locais são permitidos.

### Resultado esperado

Uma pessoa deve conseguir criar uma automação comercial, conectar seus dados, publicar uma versão **no ambiente local**, acompanhar uma execução no desenho, entender cada resultado, corrigir uma falha, recuperar a execução e transportar o fluxo para outra organização de teste.

## 2. Base encontrada e arquitetura escolhida

A análise foi feita no código local, sem validar a instalação de produção. Já existem versões publicadas, inscrições com versão fixada, eventos por etapa, dossiê textual, intervenções e proteções de envio. Há um motor de regras separado com ações reaproveitáveis.

Problemas a resolver:

- O evento de avanço pode ser gravado antes do efeito de criar tarefa, mover lead ou adicionar tag; algumas falhas não impedem a continuação.
- Os eventos atuais não constituem um contrato uniforme de input/output por execução de nó.
- Algumas ações escolhem um lead pelo contato e ordenação de atualização, sem um alvo explícito na execução.
- O dossiê e o canvas não compartilham uma visualização de execução; a leitura atual também protege configurações de quem só pode visualizar.

### Direção técnica

- Evoluir o motor existente e reutilizar escritores canônicos de CRM, fila, agendador e cadeia de envio. Não incorporar n8n, criar outro agendador ou executar ações internas via HTTP contra o próprio aplicativo.
- Manter `followup_enrollments` como identidade durável da execução, ligada ao fluxo e sua versão. Não duplicar a entidade em uma segunda tabela de execuções.
- Manter os eventos como trilha de auditoria/transição. Acrescentar registros estruturados de passagens e tentativas de nós e um diário de efeitos para recuperação.
- Não reescrever todo o motor de regras nesta iniciativa. Compartilhar serviços e contratos; manter as duas portas enquanto a compatibilidade exigir.
- Adotar um catálogo único de nós para categoria, nomes, descrição, configurações, schemas de entrada/saída, capacidades, compatibilidade de superfície e política de recuperação. Paleta, validação e executor consomem esse catálogo.
- Preservar os contratos dos roteiros de atendimento: um nó só aparece numa superfície quando houver executor efetivo nela.

## 3. Contratos que orientam todas as fases

### Execução, passagem, tentativa e efeito

- **Execução:** versão fixada, organização, origem/gatilho, contato, lead opcional explícito, conversa quando aplicável, modo, status e resultado comercial separado. Registrar vínculo com execução original nas recuperações e reinícios.
- **Passagem:** uma visita lógica a um nó, com identidade estável, sequência, iteração e caminho. Rechecagens de relógio não criam novas passagens.
- **Tentativa:** processamento de uma passagem, com início/fim, entrada resolvida, saída, erro estruturado, próxima tentativa e correlações de jobs. Tentativas diferentes nunca sobrescrevem a história anterior.
- **Efeito:** operação concreta no CRM ou canal. Sua chave independe da tentativa do worker e permanece estável na recuperação da mesma ação. Um reinício intencional constitui outra execução e outro efeito.
- Entrada/saída do domínio são dados JSON tipados, com suporte a objetos/listas e referências de arquivos. Identificadores de rastreio e status são metadados separados, não campos improvisados dentro do resultado comercial.
- Registrar parâmetros efetivamente resolvidos e as leituras de CRM utilizadas. Não apresentar dados atuais do cadastro como se fossem dados históricos.
- Para listas, preservar identificadores de itens e sua proveniência. Nesta entrega, o encadeamento comercial opera sobre um alvo individual; listas podem ser inspecionadas ou indexadas explicitamente, sem fan-out implícito.

### Estados e falhas

- Estados de execução na interface: Em execução, Aguardando prazo, Aguardando resposta, Pausada, Concluída, Falhou e Cancelada. Projetar os estados existentes, sem mudar seu significado silenciosamente.
- Estados da passagem: Pendente, Executando, Aguardando, Concluída, Ignorada, Falhou e Resultado desconhecido. Um caminho não percorrido aparece como Não executado.
- Falha transitória pode ter retry limitado; falha de configuração exige correção; efeito externo incerto exige reconciliação. O erro informa código, explicação útil, possibilidade de recuperação e correlação, sem segredos.
- Padrão dos novos nós: interromper na falha. Continuar só por tratamento explícito do erro no fluxo. Saída de erro não transforma a ação original em sucesso.
- Mensagem aceita, entregue e lida são acontecimentos distintos. Atualizações posteriores complementam a entrega, sem sobrescrever a resposta original do envio.
- Medir duração de processamento separada do tempo aguardando cliente ou prazo. Não exibir latências históricas inventadas quando não houver timestamps suficientes.

### Compatibilidade

- Acrescentar versão de contrato ao grafo; publicação nova usa o contrato novo. Grafos antigos continuam legíveis sem conversão destrutiva automática.
- Execuções em andamento mantêm a versão e semântica fixadas. Converter um fluxo legado gera rascunho novo com resumo das mudanças; não modifica execuções existentes.
- Para novas inscrições em contrato legado, preservar a operação atual durante a transição e sinalizar limitações de observabilidade. A correção completa de efeitos e recuperação passa a valer no contrato novo.
- Históricos antigos mostram os eventos disponíveis e “Entrada/saída não registrada” quando necessário. Não reconstruir outputs com suposições.
- Preservar URLs atuais de follow-up. Alterar o rótulo de navegação para Automações do CRM sem quebrar links; usar o catálogo de navegação canônico.

### Permissões e proteção dos dados

- Usar RBAC existente: leitura conforme visibilidade de contatos/leads; detalhes técnicos, configurações, exportação, importação, edição e reexecução exigem manager+. Acesso de suporte somente leitura continua bloqueando mutações.
- O modo de inspeção para leitura não expõe prompts e configurações protegidas. Dados de um lead que o usuário não pode ler também não são acessíveis pelo histórico da automação.
- Toda persistência nova é tenant-aware, com RLS, filtros explícitos de organização no service role e relações que não permitem vincular entidades de tenants diferentes.
- Segredos nunca entram em snapshots, eventos ou exportações; configurações referenciam conexões protegidas. Dados pessoais ficam restritos às superfícies autorizadas e seguem a cascata existente de anonimização.
- Defaults iniciais: payloads detalhados por 30 dias após término; metadados e resumo de auditoria por 180 dias. Mostrar e configurar essa política para manager+. Execuções ativas/pausadas e checkpoints necessários à recuperação não são limpos automaticamente por idade.
- Paginar execuções e tentativas em 50 registros. Limitar payload inline a 256 KiB; excedentes usam artefato privado paginável, com indicação na interface. Nunca truncar silenciosamente dados usados pelo motor. Arquivos permanecem referências privadas, não base64 no histórico.

## 4. Fases de implementação

Cada fase entrega um incremento revisável, documenta o que foi e não foi medido e só avança após seu aceite local. As fases 3 e 4 dependem da fase 2; as demais seguem a ordem descrita.

### Fase 0 — Preparação e regressão de referência

**Entregas**

- Registrar commit e estado da árvore; preservar arquivos locais preexistentes. Usar branch isolada do produto Estallo, sem incorporar personalizações do upstream.
- Verificar Node/pnpm, Docker, stack local e comandos existentes; preparar ambiente descartável pelo kit local do repositório. Não abrir ou imprimir arquivos `.env*`; usar os geradores existentes e `.env.example`.
- Semear duas organizações, papéis distintos, contatos com múltiplos leads, funis homônimos e exemplos de fluxos antigos.
- Capturar comportamento dos fluxos atuais: envio, espera, resposta, classificação, tarefa, tag, movimentação, pausa/handoff e opt-out.
- Registrar a especificação técnica deste épico em `docs/specs/automacoes-crm.md` durante a implementação, mantendo este arquivo como plano e checklist. Atualizar mapa de arquitetura ao acrescentar consumidores.

**Aceite:** ambiente local reproduzível, dados sintéticos e regressão de referência registrada. Nenhum recurso remoto de produção utilizado.

### Fase 1 — Modelo de execução e catálogo de nós

**Entregas**

- Acrescentar à execução o contexto explícito de lead, versão do contrato, modo e linhagem; criar estruturas de passagens/tentativas e diário de efeitos. Usar UUID v4 conforme a doutrina do repositório.
- Versionar input/output e configurações por tipo de nó; manter a identidade estável de nós e saídas em renomeações.
- Definir índices por organização/fluxo/data, execução/sequência e passagem/tentativa; unicidade das identidades de efeito e tentativas. Não indexar todo JSON sem consumidor de consulta.
- Implementar catálogo compartilhado e compatibilidade por superfície. Manter o schema antigo aceito e preparar projeção do histórico legado.
- Criar migrations novas com `-- manifest:` e apêndice idempotente no baseline. Regenerar os tipos pelo processo do banco; não editar gerados manualmente. Validar privilégios de funções novas.
- Implementar retenção e limpeza com agendamento local existente, excluindo dados necessários a execuções vivas. Integrar anonimização e remoção de artefatos privados.

**Aceite:** banco fresco e atualização com dados passam; RLS e FKs recusam relações entre organizações; tipos gerados e histórico legado funcionam.

### Fase 2 — Execução confiável e resultados por nó

**Entregas**

- Resolver a entrada e persistir a tentativa antes do trabalho; marcar sucesso somente após efeito confirmado. Persistir erros em todas as ações, sem depender apenas do logger.
- Para efeitos locais, associar mutação, resultado e identidade do efeito à mesma transação, extraindo serviços transacionais canônicos quando necessário. A gravação antecipada de “avanço” deixa de significar efeito concluído.
- Para envio e integrações, usar diário de intenção e fila duráveis, chave de idempotência e reconciliação. Não realizar HTTP em trigger ou dentro de transação longa.
- Distinguir resultado confirmado, rejeitado e desconhecido. Retomar após crash não repete efeito confirmado; crash antes/depois do commit é coberto por testes.
- Guardar snapshots do domínio para todos os nós existentes, incluindo decisões de condição, ramo escolhido, classe de IA, prazo calculado, tarefa criada, lead afetado e tags alteradas.
- Propagar o lead explícito. Na ausência dele, ação que exige lead deve pedir um seletor/resolvedor inequívoco; múltiplos leads nunca são resolvidos por “o mais atualizado”.
- Manter lease, controle de concorrência, proteção de organização suspensa, opt-out, contato pessoal/anonimizado, agenda e continuidade IA↔humano na cadeia efetiva.
- Emitir atividades no lead e manter falhas acionáveis na Central existente com link para a execução. Recuperação resolve o aviso, preservando a trilha.

**Aceite:** falha real nunca aparece como sucesso; retry/crash concorrente não duplica tarefa, tag, movimentação ou envio; pausa/cancelamento impedem avanço de resultado atrasado.

### Fase 3 — Histórico de execuções e canvas histórico

**Entregas**

- Acrescentar aba Execuções por automação e visão global na listagem. Manter a Fila como visão operacional dos trabalhos pendentes.
- Filtrar por status, período, contato, lead, versão e modo; mostrar gatilho, passo atual, duração e tentativas. Oferecer atualização automática opcional.
- Implementar leitura paginada e atualização incremental pelos mecanismos existentes de Realtime, com recuperação por polling quando necessário.
- Selecionar uma execução carrega sua versão fixada no mesmo canvas, em modo de inspeção. Destacar caminho percorrido e separar visualmente estados de execução das cores de categoria.
- Permitir selecionar passagem/iteração/tentativa de um nó. Caminhos não executados e nós ignorados devem ser distinguíveis.
- Mostrar configurações históricas apenas a quem tem permissão. Editar exige abrir rascunho separado, sem alterar a versão histórica.

**Aceite:** modificar e publicar um fluxo não altera a visualização de execuções antigas; recarregar preserva a execução selecionada; histórico legado mantém informações disponíveis sem inventar dados.

### Fase 4 — Inspetor de dados e mapeamento de variáveis

**Entregas**

- Painel amplo com Entrada, Configuração e Saída/Erro; em mobile, seções navegáveis em vez de três colunas comprimidas.
- Schema em árvore, tabela paginada e JSON com busca/cópia. Diferenciar contrato declarado, exemplo simulado e valor real da execução selecionada.
- Oferecer seletor de variáveis e arraste para campos; prévia do valor resolvido usando uma amostra explicitamente escolhida.
- Referências internas estruturadas por identidade do nó, caminho e escopo; rótulo amigável na interface. Referenciar gatilho, contexto da execução, entrada e nós ancestrais disponíveis no caminho.
- Validar tipos, referências removidas, campos obrigatórios e caminhos impossíveis na publicação. Tipos dinâmicos são conferidos em runtime; ausência de valor não vira string vazia por omissão.
- Distinguir campo ausente, `null`, string vazia e lista vazia. Campo obrigatório indisponível falha com explicação; fallback só quando configurado.
- Suportar acesso explícito a objetos/listas e iteração atual. Não permitir acesso a nós futuros, ramos não percorridos ou dados de outra execução.
- Acrescentar nó Mapear dados com seleção, renomeação, composição de texto e conversões explícitas de tipos. Manter aliases antigos de templates por compatibilidade.
- Resolver referências com interpretador restrito, sem `eval`, JavaScript livre ou acesso ao ambiente do servidor. Renomear um nó não quebra referências; excluir mostra dependentes e bloqueia publicação pendente.

**Aceite:** output de Criar lead alimenta Criar tarefa; referências sobrevivem a renomeação; erros de tipo e campos ausentes são visíveis; schema/tabela/JSON representam o mesmo conteúdo.

### Fase 5 — Categorias e novos nós comerciais

**Entregas de interface**

- Paleta com busca por nome, descrição e sinônimos; categorias recolhíveis; inserção por clique/arraste e pelo ponto de conexão no canvas. Mesmo catálogo e filtros em desktop/mobile.
- Usar tokens, tipografia e ícones do Design System Estallo, tradução existente, navegação por teclado e nomes acessíveis.

**Catálogo desta entrega**

| Categoria | Nós/capacidades |
| --- | --- |
| Gatilhos | Preservar os gatilhos com produtores existentes; editar no início do fluxo, sem permitir múltiplos inícios acidentais. |
| Contatos | Buscar contato por campos permitidos; criar contato; atualizar cadastro/campos personalizados; adicionar/remover tags do contato. |
| Leads e funil | Buscar lead; criar lead vinculado ao contato; atualizar título, valor e campos; mover etapa; mover entre funis; atribuir responsável; marcar ganho/perda; adicionar/atualizar/remover produtos do lead. |
| Equipe | Criar tarefa; registrar nota interna no destino explicitamente selecionado; definir próxima ação do lead; avisar responsável pela Central existente. |
| Mensagens | Texto, modelo e mensagem por IA como opções claras da paleta; preservar os contratos de envio existentes e os tipos de mídia já suportados pela cadeia canônica. |
| Fluxo e dados | Condição ampliada; caminhos por valor; aguardar duração; aguardar data/horário; aguardar resposta com prazo; repetição já suportada; mapear dados; encerrar. |
| IA | Classificar resposta; gerar mensagem; extrair dados estruturados segundo campos/tipos configurados, com validação da saída. |
| Integrações | Requisição HTTP com conexão protegida e output tipado; reutilizar proteções de destinos, timeout, limite de resposta, redirecionamento e idempotência existentes. |

**Regras comerciais**

- Busca individual retorna encontrado/não encontrado; múltiplos resultados geram ambiguidade tratável, nunca escolha silenciosa. Operações de criação usam normalização e regras de duplicidade canônicas.
- Campos e seletores vêm do catálogo real da organização; funil acompanha o nome da etapa. Validar produto, usuário ativo, modelo e canal no tenant.
- Distinguir responsável pelo lead de responsável pela conversa. Atribuir lead não transfere atendimento implicitamente.
- Reutilizar os serviços reais de mudança de funil e ganho/perda, com motivo da perda. Encerrar automação como convertida não marca lead ganho por si só.
- Condições passam a ler outputs e dados comerciais: valor, responsável, tags, status, campos personalizados e existência/ausência de dados. Caminhos por valor reutilizam o mesmo avaliador; não criar três motores para IF/Switch/Filtro.
- Novas esperas preservam fuso e calendário configurados. Data inválida falha; data já passada segue para o próximo nó e informa essa decisão. Esperar resposta possui saídas de resposta e prazo esgotado.
- Regra de execução vence sobre disponibilidade de paleta: a publicação recusa configuração sem suporte real. Não oferecer nós decorativos ou sucesso sem efeito.

**Aceite:** cada nó altera o alvo correto, devolve output utilizável e registra atividade/resultados. Testar contato com dois leads em funis diferentes e todos os estados de busca.

### Fase 6 — Recuperação, reinício e testes no editor

**Entregas**

- Recuperar a partir da falha cria execução vinculada com checkpoint da versão original, outputs e efeitos anteriores referenciados. Os passos herdados aparecem como herdados, sem simular novas execuções. A chave de efeito dos passos recuperados é preservada.
- Permitir recuperação somente sem executor concorrente e sem sucessora ativa de recuperação; proteger clique duplo no servidor. Execução original permanece imutável.
- Reconferir permissões, contexto do atendimento, opt-out, estado do contato e recursos do CRM antes de agir. Corrigir uma falha não autoriza sobrescrever mudanças humanas posteriores.
- Reiniciar cria execução independente desde o gatilho. Exibir versão, alvo e efeitos que podem se repetir antes da confirmação; não repetir gatilhos externos nem simular novo inbound como consequência oculta.
- Padrão: versão original. Usar versão corrigida/publicada gera novo início com o input original e contexto atual revalidado; não transplantar checkpoint entre grafos diferentes.
- Resultado desconhecido abre reconciliação. Sem evidência ou idempotência do destinatário, não oferecer reenvio automático como recuperação segura.
- Testar nó e caminho no rascunho com dados simulados/fixados por nó. Exemplos são separados do runtime e nunca usados por execuções automáticas publicadas.
- Simulação não muta CRM nem envia mensagens/chamadas externas; produz efeitos previstos claramente identificados. Testes reais locais usam organização e destinatário de teste explícitos, cadeia real e confirmação dos efeitos.
- Exibir vínculo da tentativa com a falha original; avisos operacionais são atualizados após recuperação, não apagados.

**Aceite:** recuperar não duplica efeitos concluídos; reiniciar repete somente como nova ação intencional; simulação deixa CRM/canais inalterados; ação bloqueada por atendimento humano não volta a falar após resultado atrasado.

### Fase 7 — Exportação e importação JSON

**Entregas**

- Exportar rascunho ou versão publicada escolhida, identificando a origem. Pacote com versão do formato, metadados, grafo, posições, configurações, variáveis, políticas e manifesto de dependências.
- Exportar referências de conexões, nunca valores de credenciais. Excluir execuções, outputs, amostras fixadas e dados pessoais de clientes. Detectar segredos embutidos em configurações/headers e exigir substituição por conexão protegida antes de exportar.
- Validar arquivo por schema e limites antes de qualquer escrita. Nesta entrega, importação por arquivo; não importar de URL nem executar código do pacote.
- Oferecer prévia, relatório de incompatibilidades e remapeamento de funis/etapas, usuários, agentes, canais, modelos, campos, produtos e fluxos dependentes. Nomes iguais não autorizam vinculação automática ambígua.
- Gerar novos IDs de nós ao importar e reescrever suas referências estruturadas; referências externas precisam pertencer ao tenant de destino. Toda remarcação é validada.
- Importação cria um único rascunho de forma atômica; não publica, dispara, cria canais ou instala dependências. Pacotes com versão futura são recusados com mensagem útil.
- Exportar novamente o fluxo importado preserva semântica e conexões, desconsiderando IDs e metadados novos. Formato nativo do Estallo, sem promessa de compatibilidade direta com JSON de n8n.

**Aceite:** exportar na organização A, importar/remapear na B e executar só sobre dados da B; falha de importação não deixa gravações parciais; pacote não contém segredos ou históricos.

### Fase 8 — Homologação integrada e entrega local

**Entregas**

- Ambiente local fresco com baseline completo, aplicativo buildado, worker, agendamento e Realtime ativos; segundo cenário de atualização com dados existentes.
- Roteiro de homologação pela tela para o proprietário, com fluxos de exemplo, entradas e resultados esperados. Guardar screenshots/traces e relatório de comandos e limitações.
- Validar desktop/mobile, claro/escuro, teclado, contraste, tradução e RBAC. Medir listagem e inspeção com 10 mil execuções sintéticas e passagem com múltiplas tentativas, sem carregar todos os payloads no canvas.
- Executar cenários reais locais com canal e IA de teste quando disponíveis; separar esses resultados dos testes simulados. Se faltar recurso real, marcar o caso como pendente e não como homologado.
- Documentar configuração, recuperação, importação, retenção e diagnóstico; atualizar arquitetura, navegação e fragmento de release sem cortar versão nem publicar.

**Aceite:** matriz abaixo aprovada; pendências explícitas resolvidas ou mantidas como bloqueio de homologação; proprietário consegue reproduzir as jornadas. A fase termina com código, migrations e evidências locais prontos para revisão. Deploy permanece fora do trabalho.

## 5. APIs e interfaces

Manter os endpoints existentes. Acrescentar operações sob a família atual de automações/follow-ups, sem uma API concorrente com nomes diferentes para a mesma execução:

| Operação | Interface planejada |
| --- | --- |
| Listar execuções | `GET /api/v1/ai/followups/executions` com filtros e cursor; cada ID corresponde à inscrição existente. |
| Ler execução/canvas | `GET /api/v1/ai/followups/executions/:id` com grafo histórico projetado conforme permissão, estados e resumo. |
| Ler tentativas | `GET /api/v1/ai/followups/executions/:id/steps` com cursor; payload detalhado carregado sob demanda por passagem/tentativa. |
| Inspecionar dados | `GET /api/v1/ai/followups/executions/:id/steps/:step_id/attempts/:attempt_id` para input/output/erro autorizados. |
| Recuperar/reiniciar | `POST /api/v1/ai/followups/executions/:id/retry` e `/restart`, com chave de idempotência do pedido e versão/alvo explícitos no reinício. |
| Catálogo | `GET /api/v1/ai/followup-flows/node-catalog` respeitando superfície, capacidades e permissões. |
| Testar rascunho | `POST /api/v1/ai/followup-flows/:id/test` para simulação ou execução de teste autorizada, com revisão esperada do rascunho. |
| Exportar | `GET /api/v1/ai/followup-flows/:id/export` com seleção de rascunho/versão. |
| Pré-validar/importar | `POST /api/v1/ai/followup-flows/import/preview` e `/import`, com pacote e remapeamentos validados novamente no commit. |

Todas as rotas usam Zod, guards canônicos, `organization_id` confiável, `requireSupportWrite` quando mutantes, auditoria e `ok`/`fail`. Novas operações não entram na allowlist pública nem aceitam bearer por consequência desta mudança. JSON em snake_case; UUID v4; datas UTC; dinheiro em centavos com moeda. Relógio de execução vem do servidor.

## 6. Matriz mínima de testes e cenários de aceite

| Grupo | Cenários obrigatórios |
| --- | --- |
| Compatibilidade | Fluxo antigo abre/executa; execução antiga não muda após nova publicação; histórico incompleto identifica ausências. |
| Efeitos | Tarefa, tag, lead e movimentação falham de verdade e ficam vermelhos; crash antes/depois do commit; job repetido; dois workers; resposta externa perdida. |
| Dados | Objetos/listas, `null`, ausente, vazio, tipo inválido, saída dinâmica, payload grande, arquivo privado; renomeação/exclusão de nó; ramo não percorrido. |
| Canvas | Caminho exato, espera, erro, ignorado, iterações e tentativas; tempo ativo separado da espera; reconexão de Realtime. |
| CRM | Contato com vários leads; etapa homônima; recurso arquivado; responsável revogado; produto inválido; ganho/perda e motivo; mudança humana antes da recuperação. |
| Recuperação | Retry sem duplicação, clique duplo, lease ativa, sucessora ativa, checkpoint expirado, restart original/corrigido e efeitos previstos. |
| Atendimento | Opt-out, anonimização, contato pessoal, organização suspensa, humano assume, humano devolve à IA, resultado atrasado e proteção de agenda. |
| Portabilidade | Round-trip JSON, duas organizações, dependência ausente, formato futuro, referência quebrada, pacote com segredo, importação atômica. |
| Permissões | Viewer/member/manager, visibilidade por lead, suporte somente leitura, tentativa cross-tenant nas APIs, RLS e artefatos. |
| Retenção | Limpeza pós-prazo, execução ativa preservada, anonimização alcança snapshots/artefatos, UI informa expiração e recuperação indisponível. |

Jornadas pela interface:

1. Lead entra em Proposta enviada → aguarda → verifica status → envia mensagem → aguarda resposta → classifica → registra nota e tarefa para responsável. Inspecionar cada output e variável utilizada.
2. Criar lead → reutilizar seu ID em tarefa e produto → provocar falha de configuração → corrigir recurso → recuperar e provar ausência de duplicações.
3. Publicar nova versão enquanto execução antiga aguarda → comprovar ambas as versões no histórico e o respeito ao controle humano.
4. Exportar/importar entre duas organizações de teste → remapear dependências → simular → publicar localmente e executar.

Verificação final local: `pnpm gov:verify`, `pnpm test:db`, `pnpm test:db:update`, `pnpm build` e `pnpm test:e2e` com ambiente de teste local gerado pelos scripts existentes. Rodar `pnpm test:shell` se Docker, compose ou scripts de operação forem alterados. Não usar `pnpm db:migrate` como prova: o script atual é placeholder. Testes de canal/IA relevantes precisam de recursos reais de teste; se atravessarem o agente, comprovar também a ferramenta diretamente com o mesmo texto cru. Testes críticos devem demonstrar que detectam a regressão por sabotagem controlada e restauração.

## 7. Continuidade, configuração e limites finais

- Entrada: gatilhos reais e inscrições manuais autorizadas; saída: escritores canônicos do CRM, tarefas, mensagens e integrações.
- Registro: trilha de execução, auditoria, atividade do lead e entrega; superfície: Execuções, canvas, timeline e Central de avisos existente.
- Continuidade humana: pausa, cancelamento, recuperação, próxima ação e contexto; automação não reassume atendimento por simples retry.
- Configuração: editor, política de erros, retenção e conexões protegidas; dependência ausente aparece como problema acionável.
- Laço de retorno: falha leva à execução e à correção do recurso/rascunho; recuperação liga tentativas e resolve o aviso. Métricas de conclusão são acompanhadas de falhas, duplicações, opt-outs e intervenções humanas, sem otimização automática de prompts neste épico.
- Destino: núcleo do CRM, pois catálogo, execução inspecionável e recuperação são capacidades comuns da plataforma.

Ficam para outro plano: processamento em lote e loops de listas, Merge/paralelismo, JavaScript livre, marketplace de conectores, novos canais Instagram/e-mail, módulos avançados de agenda, transferência de atendimento como novo nó, subfluxos genéricos e compatibilidade de importação com n8n. Preservar recursos existentes nesses domínios.

**Conclusão da entrega:** homologação local e documentação revisável. A decisão e o procedimento de subir para produção serão tratados depois, com nova autorização do proprietário; nenhuma fase acima executa deploy.
