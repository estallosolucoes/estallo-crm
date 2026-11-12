---
impacto: capacidade_nova
secao: adicionado
titulo: A publicação recusa variável que cita um campo que o bloco não produz
---
Ao publicar um fluxo, uma variável de bloco anterior como `{{nodes.condicao.task_id}}` agora é recusada quando aquele tipo de bloco não produz esse campo, e a mensagem lista os campos que existem. Antes, o texto seria enviado sem o valor.
