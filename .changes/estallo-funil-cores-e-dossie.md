---
impacto: capacidade_nova
secao: adicionado
titulo: Etapas com cor, e um dossiê do negócio com trilho de etapas, ganho/perdido e "Mover de funil"
---

Cada etapa do funil agora tem cor: etapa nova nasce com uma cor sorteada da paleta, diferente da etapa anterior, e as etapas que já existiam recebem cores em sequência na atualização (migration 0655, trigger `trg_crm_stages_cor_padrao`). A cor é editável em Configurações › Funis e vira a borda da coluna no quadro. O dossiê do negócio ganhou no topo o trilho das etapas abertas do funil, com a cor de cada uma e os dias na etapa atual — um clique muda a etapa, e funil comprido rola na horizontal —, além dos botões ✓ (ganho) e ✕ (perdido) e de "Mover de funil" no canto superior direito. Mover de funil agora leva o MESMO negócio (id, conversa, tarefas, campos e histórico) para a etapa escolhida do outro funil (`POST /api/v1/leads/[id]/move-pipeline`); antes o sistema encerrava o original e criava uma cópia. O item do menu do card também passou a se chamar "Mover de funil".
