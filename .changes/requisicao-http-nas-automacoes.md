---
impacto: capacidade_nova
secao: adicionado
titulo: Bloco Requisição HTTP nas automações, com conexão protegida
---
O construtor de automações ganhou o bloco «Requisição HTTP», que chama um sistema externo e entrega a resposta para os blocos seguintes usarem como variável. A credencial fica numa conexão cadastrada pelo administrador, guardada cifrada com a chave da instalação (`AI_CRED_AES_KEY`), e só é usada para chamar o endereço daquela conexão. Se a resposta não chegar, a execução para para revisão na Central e nada é reenviado sozinho. A migration 0716 é aplicada pelo baseline.
