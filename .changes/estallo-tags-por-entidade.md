---
impacto: exige_acao
secao: alterado
titulo: Tags por oportunidade e contato numa tela do CRM, e conversa deixa de ter tag
---

**Tela nova.** CRM › Tags (/app/crm/tags, gerente) substitui Configurações › Tags (o endereço antigo redireciona). A tela tem abas Oportunidade e Contato com contagem, busca, e uma tabela com nome, cor e ações. "Nova Tag" pede nome, entidade e cor (cores da marca Estallo e cores adicionais, com prévia). Editar renomeia e troca a cor; excluir avisa quantos registros perdem a tag e quantas regras de automação ainda a escrevem. A mesma etiqueta pode existir nas duas entidades, cada uma com sua cor.

**Atribuir.** No contato e na oportunidade, o campo de tags oferece as tags cadastradas daquela entidade, com cor, e permite criar uma nova na hora. O campo "Tags (separadas por vírgula)" do negócio deu lugar a esse seletor.

**Conversa sem tag (exige ação de quem usava).** As tags gravadas em conversas são apagadas na atualização (migration 0659). Saem com elas:
- o editor "Tags da conversa" do inbox;
- a rota `GET /api/v1/conversation-tags`;
- o campo `tags` do `PATCH /api/v1/conversations/{id}`, que agora é recusado;
- o alvo `conversation` da ferramenta MCP `crm_manage_tags`;
- a aba "Por etiqueta" de Atividades e a rota `/api/v1/reports/tags`, que só mediam tag de conversa.

Integração que gravava tag em conversa deve passar a gravar no contato. O filtro de tag do inbox continua, pelas tags do contato. `crm_list_tags` agora lista o cadastro por entidade (`lead` ou `contact`).

**Referências preservadas.** A migration dá entidade a cada entrada do cadastro conforme o uso (contatos, negócios, regras `add_tag` pelo destino, nós de follow-up) e não apaga nenhuma tag de contato, de negócio nem de regra. Renomear numa entidade corrige também as regras de automação daquele destino.

**Correção.** Excluir uma tag tirava **todas** as tags dos registros que a tinham. Agora sai só a escolhida.

## Requer atenção

As tags de conversa são apagadas ao atualizar. Antes, se alguma operação dependia delas (filtro, relatório "Por etiqueta", integração que gravava pela API ou pela ferramenta MCP), passe a marcar o **contato**. Integração que manda `tags` no `PATCH /api/v1/conversations/{id}` ou usa `crm_manage_tags` com `target_kind: "conversation"` passa a receber recusa.
