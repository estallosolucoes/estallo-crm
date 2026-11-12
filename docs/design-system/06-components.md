# 06 — Componentes Estallo no CRM

Referência visual: [Design System Estallo](README.md). Implementação compartilhada: `components/ui/`, `components/` e tokens de `app/globals.css`. O showcase herdado não define variants nem estilos do produto.

## Composição e estados

Reutilizar os componentes existentes. Antes de criar uma variante, conferir o contrato do componente e seus consumidores. Não assumir que um inventário antigo descreve a API atual.

| Superfície          | Regra                                                           |
| ------------------- | --------------------------------------------------------------- |
| Botão principal     | Azul de ação com contraste; uma ação prioritária por contexto   |
| Botão secundário    | Superfície neutra e hierarquia inferior à principal             |
| Ação destrutiva     | Cor de erro, consequência clara e confirmação quando necessária |
| Input e formulário  | Label persistente, ajuda próxima e erro relacionado ao campo    |
| Card e tabela       | Hierarquia, comparação e responsável/próximo passo visíveis     |
| Badge               | Estado em texto; não só cor                                     |
| Modal, sheet e menu | Foco gerenciado, teclado, escape e retorno ao acionador         |
| Toast e aviso       | Resultado compreensível e orientação para continuar             |
| Skeleton e loading  | Preservar contexto e estrutura; redução de movimento            |

Todo componente interativo prevê default, hover, active, focus-visible, disabled, loading, sucesso e falha quando aplicável. Não inventar um estado visual sem retorno operacional.

## Atendimento e vendas

Inbox, conversa, composer, card de lead e painel do contato adotam a mesma identidade Estallo. As relações entre os dados, o fluxo de envio e o handoff permanecem governados pelas specs técnicas. O redesign precisa preservar status de envio, rascunho, erro recuperável, acesso por papel e histórico.

## Validação

Provar teclado, desktop/mobile, claro/escuro, conteúdo longo, estados vazios e falhas. Utilizar tokens semânticos; não copiar `.ds-*` do laboratório sem conferir a implementação real. A revisão interna dos módulos continua progressiva.

O Inbox organiza a lista em **Todas | Sem resposta | Em espera | Em aberto | Fechadas**. Sem resposta preserva a regra de Pendentes (entrada existente e nenhuma saída); Em espera exige uma saída anterior e entrada mais recente; Em aberto tem saída sem entrada posterior. Grupos não recebem categoria de resposta. Fechadas inclui o legado arquivado. Não há categoria nem posição de fila na lista. Os contadores e a listagem consultam o banco antes da paginação; o ciclo de vida e o roteamento continuam separados dessa apresentação.

A lista arrastável tem piso de 380px no desktop; os gatilhos das categorias preservam a largura do rótulo com espaçamento próprio e rolagem quando necessário, inclusive em telas pequenas e zoom alto. O botão de informação junto a Inbox abre a ajuda dos cinco status. Canais usa o nome das instâncias e Ordem altera a data da última mensagem, com desempate por ID e conversas fixadas no topo.
