---
impacto: nada_mudou
secao: corrigido
titulo: Avisos de lead sem duplicar e fluxos que correm em segundos
---
Mover um negócio mostrava «Lead atribuído a você» duas vezes: o navegador não recebia o valor anterior do dono e achava que todo salvamento era uma atribuição nova. A tabela de negócios agora publica a linha antiga no tempo real (a atualização do banco aplica isso sozinha), e o navegador só avisa quando consegue comparar. Os fluxos de automação também deixaram de avançar um bloco por minuto: o motor repete as passadas durante cerca de 18 segundos de cada rodada, então um fluxo sem espera termina em segundos depois de iniciado.
