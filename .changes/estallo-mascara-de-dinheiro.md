---
impacto: capacidade_nova
secao: alterado
titulo: Todo campo de dinheiro com a mesma máscara (R$ 0,00), digitação da direita para a esquerda
---

Os campos de dinheiro passaram a usar um único componente, `CampoDeDinheiro`. Ele mostra o símbolo da moeda antes do valor, aceita só números e preenche da direita para a esquerda, sempre com duas casas: digitar "1" mostra 0,01, "123" mostra 1,23 e "1234567" mostra 12.345,67. Ponto separa o milhar e vírgula separa o decimal. Colar "R$ 1.234,56" ou "249.90" lê o texto como valor. O que é gravado não mudou: centavos (ou reais, no campo personalizado de moeda), lidos pela mesma função de antes.

Telas atualizadas:
- Funil: valor do negócio no Novo Lead, no Editar e na ficha do lead; desconto por produto.
- Produtos: preço de venda no cadastro e na edição.
- Propostas: preço unitário e desconto.
- Comandas: valor do item.
- Faturamento: valor do lançamento.
- Financeiro: valor da recorrência.
- Honorários: valor fixo e valor da parcela.
- Agenda: preço padrão do tipo.
- Campo personalizado de moeda e campos obrigatórios de moeda ao mover de etapa.
- IA: limite mensal (US$), custo máximo por atendimento do agente (US$, antes digitado em centavos) e teto da busca de prospecção (US$).
- Administração: preço do plano e teto de IA do plano.

Com isso, três leituras erradas deixam de acontecer:
- No valor fixo de honorários e no preço de plano, "1.500" virava R$ 1,50.
- Nas propostas, o separador decimal dependia do navegador.
- No preço padrão da agenda, um texto ilegível apagava o preço.
