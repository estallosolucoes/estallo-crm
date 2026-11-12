-- manifest: crm_leads passa a publicar a linha ANTIGA inteira no realtime (replica identity full), para os avisos "Lead atribuído a você / ganho / perdido" compararem com o valor de antes em vez de dispararem a cada salvamento
--
-- Medido em produção (Estallo, 04/11/2026): mover um negócio mostrava "Lead atribuído a você" DUAS vezes.
-- `hooks/notifications/useCrmAlerts.ts` assina UPDATE de `crm_leads` e só avisa quando `owner_user_id` mudou
-- (`owner !== ownerAntes`). Mas com a identidade de réplica padrão (chave primária) o realtime entrega em `old` só o
-- `id`: `ownerAntes` era sempre nulo, e TODO update de um negócio do próprio usuário parecia uma atribuição nova.
-- Mover o card dá dois updates (a etapa e o carimbo de última atividade), daí o aviso em dobro. O mesmo vale para
-- "Lead ganho" e "Lead perdido" (`statusAntes`).
--
-- `replica identity full` faz o WAL carregar a linha antiga, e o realtime a entrega em `old`. O custo é WAL maior nos
-- updates de `crm_leads`; é a mesma tabela que já vive no realtime, e o volume de updates de negócio é de cliques
-- humanos e de automações, não de ingestão em massa.
--
-- Idempotente: repetir não muda nada. Portável em psql puro.

alter table if exists public.crm_leads replica identity full;
