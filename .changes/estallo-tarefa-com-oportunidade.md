---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas podem ser vinculadas a uma oportunidade direto na tela de Tarefas
---

O formulário de tarefa em /app/tasks ganhou o campo "Oportunidade": "Vincular a uma oportunidade" abre a busca "Selecionar Oportunidade" pelo título do negócio, e o vínculo pode ser removido na edição. Quem cria a tarefa pelo dossiê do negócio continua com o vínculo automático. Para a busca, `GET /api/v1/leads?search=&status=&limit=` passou a existir (viewer+, pela sessão e RLS, devolvendo só id, título, status e funil).
