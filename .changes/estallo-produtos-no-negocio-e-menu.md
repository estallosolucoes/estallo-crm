---
impacto: capacidade_nova
secao: adicionado
titulo: Produtos no negócio com desconto, filtro por produto no funil, funis fixados e menu lateral renovado
---

O card do negócio ganhou o bloco "Produtos": escolhe-se do catálogo, ajusta-se a quantidade e o desconto de cada item, e o valor do negócio passa a ser a soma, já com os descontos — calculado pelo banco (tabela `crm_lead_products`, migration 0660), seja quem for que mexa nos itens. Nome e preço são copiados do catálogo na hora de vincular, então mudar o preço depois não reescreve negócio já montado. O quadro do funil filtra por produto. Até três funis podem ser fixados no menu lateral, acima de "Funis", pelo botão "Fixar no menu" no quadro ou na lista de funis; com o menu recolhido, cada um leva o seu número. O menu lateral adota ícones em suporte de 36px e o item ativo em azul com filete. Contatos passou para Atendimento, a chave da Agenda mora em Configurações › Recursos opcionais, e a tela de Produtos não pede mais Marca nem Custo (os dados já gravados ficam no banco). A atualização aplica a migration pelo `baseline.sql`, sem passo manual.
