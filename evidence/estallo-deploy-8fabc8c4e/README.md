# Atualização direta do Estallo CRM — 14/10/2026

Domínio verificado: https://crm.estallo.com.br. Imagens Linux/AMD64 da revisão `8fabc8c4e206f67352550a9615d60eb8a7a9a04e`, construídas no computador da Estallo e transferidas por SSH. Nenhum workflow foi acionado e nenhum build foi executado na VPS.

O clone operacional recebeu também o commit documental `3df3075a90c37ed5f0b11d2b075cffd49c379d05`. Essa diferença só preserva referências das capturas históricas; não altera o runtime das imagens.

## Escopo publicado

- Inbox com composer simplificado e oportunidades recentes ligadas ao dossiê.
- Cores das etapas e melhorias do dossiê, incluindo movimentação entre funis.
- Vínculo de tarefa com oportunidade.
- Navegação com IA, Canais e Análise fechados inicialmente; rail recolhido concentrado em Atendimento e CRM.
- Chave de Agenda por empresa e cadastro central de campos personalizados.
- Remoção da oferta de Google Meet, preservando leitura de compromissos históricos.
- Documentação com o Design System Estallo como única referência visual vigente.

Aplicadas as migrations 0655, 0656, 0657 e 0658, após backup. Não foi reaplicado indiscriminadamente o baseline em produção.

## Prova pela interface

Login real do administrador, sem publicar suas credenciais. Verificações de leitura e abertura de formulários; nenhuma tarefa, oportunidade ou campo foi criado pelo QA. Nenhuma mensagem ou cobrança foi enviada pelo QA.

| Captura                                                       | Verificação                                             |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `evidence/estallo-deploy-8fabc8c4e/login-desktop.png`         | Login e identidade, tema claro                          |
| `evidence/estallo-deploy-8fabc8c4e/login-escuro.png`          | Login, tema escuro                                      |
| `evidence/estallo-deploy-8fabc8c4e/login-mobile.png`          | Login mobile claro                                      |
| `evidence/estallo-deploy-8fabc8c4e/login-mobile-escuro.png`   | Login mobile escuro                                     |
| `evidence/estallo-deploy-8fabc8c4e/planos-desktop.png`        | Planos demonstrativos e contratação desabilitada        |
| `evidence/estallo-deploy-8fabc8c4e/planos-escuro.png`         | Planos no tema escuro                                   |
| `evidence/estallo-deploy-8fabc8c4e/planos-mobile.png`         | Planos no mobile                                        |
| `evidence/estallo-deploy-8fabc8c4e/navegacao-recolhida.png`   | Navegação recolhida                                     |
| `evidence/estallo-deploy-8fabc8c4e/navegacao-mobile.png`      | Gaveta mobile                                           |
| `evidence/estallo-deploy-8fabc8c4e/crm-recursos.png`          | Chave da Agenda e acesso aos campos personalizados      |
| `evidence/estallo-deploy-8fabc8c4e/campos-personalizados.png` | Cadastro central carregado, sem dados fictícios         |
| `evidence/estallo-deploy-8fabc8c4e/tarefa-oportunidade.png`   | Formulário com vínculo de oportunidade, antes de salvar |

Resultados estruturados: [identidade](resultado.json), [funcionalidades](funcionalidades.json) e [operação](operacao.json). A pesquisa de oportunidade abriu; Funis e Inbox foram acessados sem erro de navegador. As capturas não comprovam mutações de negócio completas nem todas as variantes dos módulos.

## Operação

As seis dependências/serviços foram considerados saudáveis pelo operador. HTTPS e redirecionamento de `/app` passaram; a sessão WAHA permaneceu `WORKING`. Não foi repetido o teste de envio/recebimento nesta atualização. Banco: RLS ativo na tabela de definições, sem SELECT/INSERT para anon, nenhuma etapa sem cor e nenhum tipo configurado como Google Meet.

A comparação manteve os mesmos 21 contêineres de outros projetos e as mesmas respostas nos 26 domínios verificados. Sem OOM; memória disponível de 1.433 MB na conferência. Imagens anteriores e configuração permanecem disponíveis para rollback; não houve ensaio adicional de rollback neste deploy.

## Validação e limites

- Typecheck, lint, lint de canais e lint de rank passaram.
- Build Linux das três imagens passou, com arquitetura e procedência verificadas. Arquivo de imagens: 568.139.970 bytes; SHA-256 `1460f57ff30c60a0d178f5bc5775c6010197c76e9c238c4bda109826ca0640ed`, igual nos dois lados.
- 31 arquivos unitários alterados: 259 casos passaram em Linux.
- Banco: instalação/reaplicação do baseline e 107 casos de projeção/isolamento passaram em Postgres descartável.
- Operador Swarm: 25 casos passaram. Referências documentais: 4 casos passaram. Evidências históricas: 67 casos passaram antes de acrescentar este relatório.
- Quatro cercas repetidas em Linux: 23 casos passaram. O ambiente foi completado com ferramentas GNU e prazo de 120 s para varreduras sob carga; as asserções foram preservadas.
- A suíte ampla Windows foi interrompida depois de registrar falhas; não foi aprovada. Há incompatibilidades de caminhos/ferramentas e pendências em traduções, selos de documentos derivados, fragmento de release e testes herdados de recursos removidos/white-label/cobrança. Não houve execução completa de E2E contra Supabase local nesta atualização.
- Dos 43 scripts do kit, 39 passaram em Linux. Pendências: dois casos de seleção/pin de release em `hostgator-setup-kit/test-validators.sh`, além de `colisao-de-migration.test.sh`, `hooks-nao-acusam-a-main.test.sh` e `instalar-guias.test.sh`. O QA usou um snapshot Git isolado, sem a mesma população de refs/hooks do clone original; não se atribui automaticamente cada falha ao produto. Esse kit genérico não executou a atualização Swarm.

Os logs completos de verificação ficam fora do Git, em `C:\Users\junio\.estallo-crm\deploy-20261014-*.log`. Os backups e credenciais também ficam fora do Git. Stripe e revisão completa dos módulos internos continuam pendentes, conforme a direção do produto.

## Fechamento documental e backup

A confer?ncia final de refer?ncias e evid?ncias passou em 72 casos, com este relat?rio e suas capturas versionados. Os backups anterior e posterior ? atualiza??o foram criados pelo operador. Imagens e bundles Git foram copiados para `C:\Users\junio\OneDrive\Documentos\backup-estallo-crm\artifacts-8fabc8c4e`, com checksum conferido. A c?pia para a pasta local do OneDrive n?o comprova, por si s?, que o cliente OneDrive terminou de enviar os arquivos ? nuvem. Os recibos da tarefa de backup confirmam a c?pia dos dumps para o computador.
