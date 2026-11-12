-- manifest: **A Agenda vira chave da empresa, desligada por padrão.** `organizations.settings.agenda_habilitada` (capacidade `agenda` em `lib/organizacao/capacidades.ts`) esconde tela, menu e ferramentas de agendamento do agente quando falsa; liga em /app/crm. Data migration: empresas que já têm tipo de agendamento ou compromisso recebem a chave ligada, só onde ela ainda não existe (re-aplicar não religa).

-- ---- a Agenda vira chave da empresa, desligada por padrão (migration 0656) ----
-- A chave é `organizations.settings.agenda_habilitada` (lida por
-- lib/organizacao/capacidades.ts). Fora de `settings.agenda` de propósito:
-- aquele objeto é reescrito inteiro por `fn_agenda_settings`.
--
-- Quem JÁ usa a Agenda (tem tipo de agendamento ou compromisso) não pode
-- perdê-la na atualização: liga a chave para essas empresas. Só onde a chave
-- ainda não existe — re-aplicar o baseline nunca religa o que a empresa desligou.
update public.organizations o
   set settings = coalesce(o.settings, '{}'::jsonb) || jsonb_build_object('agenda_habilitada', true)
 where not (coalesce(o.settings, '{}'::jsonb) ? 'agenda_habilitada')
   and (
     exists (select 1 from public.calendar_event_types t where t.organization_id = o.id)
     or exists (select 1 from public.calendar_appointments a where a.organization_id = o.id)
   );

