# Estallo CRM — visão e direção do produto

Decisões do proprietário em 13/10/2026. Este documento substitui o posicionamento comercial herdado do upstream.

## Produto e público

O Estallo CRM é um SaaS da Estallo para empresas que atendem e vendem por WhatsApp. Reúne atendimento, clientes, funil, agenda e automação com IA. A Estallo hospeda, administra e comercializa a plataforma; cada organização usa uma conta isolada por RLS e pelas permissões existentes.

A identidade do aplicativo é sempre Estallo CRM. O cliente mantém seu nome, cadastro, dados legais e identidade nos documentos comerciais. Esses dados não substituem o logo, as cores, os títulos ou a navegação do produto. As estruturas de white-label herdadas permanecem como compatibilidade técnica, sem participação na identidade do SaaS.

## Referência visual única

O [Design System Estallo](design-system/README.md), baseado no Estallo Brand System v1.0 fornecido pelo proprietário, é o único padrão visual deste produto. Substitui a identidade herdada em documentação, specs e decisões futuras. Tokens operacionais vivem em `app/globals.css`; adaptações do CRM devem manter a identidade e a acessibilidade. O laboratório antigo não é referência normativa.

A implantação do padrão é progressiva: a primeira etapa abaixo está entregue; o redesenho interno dos módulos continua pendente, sob essa mesma referência.

## Identidade e navegação — primeira etapa

- Símbolo e logotipo oficiais da Estallo, com descritor CRM; fontes Sora, Manrope e JetBrains Mono servidas pelo aplicativo.
- Azul para ação, verde para resultado, Ink para navegação e texto. Variações mais escuras nos controles garantem leitura; cores originais preservadas na assinatura da marca.
- Navegação por objetivos: Atendimento, CRM, Agente de IA, Canais e Análise. Configurações permanece no rodapé; permissões, hubs, busca e navegação mobile continuam usando o catálogo canônico.
- A empresa ativa aparece como contexto da conta, sem alterar a marca do produto. Claro e escuro têm tokens próprios.
- A primeira etapa muda identidade, estrutura visual da navegação, acesso e apresentação dos planos. O redesenho interno de Inbox, kanban, dashboard e demais módulos será expandido depois.

## Comercial — demonstração, sem cobrança

A base comercial futura será adaptada da implementação Stripe do Nutrigg, indicada pelo proprietário. O módulo de cobrança herdado do upstream não é a base comercial desta oferta. Seu schema e seus contratos não são removidos nesta etapa.

| Plano demonstrativo | Preço mensal fictício | Usuários | Números | Contatos |
| ------------------- | --------------------: | -------: | ------: | -------: |
| Essencial           |                 R$ 97 |        3 |       1 |    1.000 |
| Profissional        |                R$ 197 |       10 |       3 |    5.000 |
| Escala              |                R$ 397 |       25 |       5 |   20.000 |

Os valores e limites são ilustrações para validar a apresentação. Não são uma oferta definitiva, não geram cobrança e não limitam a conta atual. A tela Plano e cobrança informa isso e não oferece checkout ativo. Não há franquia de IA contratada nesta fase.

Pendências para ativar Stripe:

- Definir produtos, preços finais, periodicidade, trial, franquias de IA e política de alteração/cancelamento.
- Disponibilizar `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` e IDs de preços em configuração protegida; nunca no Git ou no chat.
- Adaptar do Nutrigg Checkout e Portal hospedados pelo Stripe, vinculados à organização autenticada no servidor.
- Conferir assinatura do webhook sobre o corpo cru, idempotência e estado relido no Stripe; redirecionamento do navegador não concede acesso.
- Definir e provar limites no servidor, conciliação, alertas de consumo, inadimplência e isolamento entre organizações antes de comercializar.

## Operação e aceite

A implantação atual é um piloto; não constitui dimensionamento de uma plataforma comercial. Escalabilidade, WhatsApps simultâneos, capacidade e disponibilidade precisam de validação antes da abertura a clientes.

GitHub Actions permanece desativado por decisão do proprietário após esgotamento da cota. Esta etapa é validada localmente, sem disparar workflows. A VPS de produção não faz build: as imagens são construídas fora dela e transferidas por SSH (ver `docs/estallo-vps.md`).

Aceite desta etapa: marca consistente em acesso, navegação e ícones; operação desktop/mobile e claro/escuro; catálogo de navegação preservando RBAC; planos claramente demonstrativos; documentação coerente; ausência de alterações na licença MIT e no schema.

## Living System Checklist

1. Entrada: Design System oficial, catálogo de navegação, organização ativa e papéis autenticados.
2. Saída: componentes de marca, shell, acesso e tela Plano e cobrança.
3. Registro: navegação é leitura; não cria cobrança, assinatura ou alteração de configuração.
4. Superfície: menu lateral/mobile, barra superior, login e Configurações.
5. Porta: catálogo existente leva a Plano e cobrança e Identidade do produto.
6. Anti-morte: estados demonstrativos dizem por que não há contratação; dados da empresa têm link para o cadastro.
7. Configuração: identidade pertence ao produto; dados da empresa continuam em Configurações. Stripe é pendência operacional explícita.
8. Continuidade: atendimento e handoff não mudam nesta etapa.
9. Retorno: falhas visuais são verificadas em desktop/mobile, temas e navegação; ausência de Stripe não inicia uma operação financeira.
10. Mapa: `architecture/estallo-identidade.architecture.json` registra as relações desta etapa.

## Origem

O produto deriva do DeskcommCRM. Histórico, copyright e licença MIT da base permanecem preservados. Documentos históricos do upstream não definem a oferta comercial da Estallo.
