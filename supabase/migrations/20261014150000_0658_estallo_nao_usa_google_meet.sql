-- manifest: **O Estallo não usa Google Meet.** Tipos de agendamento com local `google_meet` passam a `whatsapp` e a chave `settings.google_meet_acesso_aberto` sai das organizações; o app deixa de oferecer o local, a opção e o escopo do Meet no OAuth do Google. Colunas `meeting_*` e funções `fn_meet_*` ficam no banco sem uso (lidas por funções do envio e da sincronização).

-- ---- o Estallo não usa Google Meet (migration 0658) ----
-- O produto deixou de oferecer o local "Google Meet" e a opção "Meet com acesso
-- aberto". Tipo de agendamento que estava em Google Meet passa a WhatsApp (o
-- único local online que não pede dado extra na marcação), e a chave da opção
-- sai das organizações. Idempotente: re-aplicar não acha mais nada.
-- As colunas e funções `meeting_*`/`fn_meet_*` ficam no banco, sem uso: elas
-- são lidas por funções do envio de resposta e da sincronização com o Google,
-- e reescrevê-las é uma mudança à parte.
update public.calendar_event_types
   set location_kind = 'whatsapp'
 where location_kind = 'google_meet';

update public.organizations
   set settings = settings - 'google_meet_acesso_aberto'
 where settings ? 'google_meet_acesso_aberto';

