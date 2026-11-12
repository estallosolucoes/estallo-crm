-- manifest: RLS de conversations sem fn_can_view_conversation por linha (a mesma visibilidade, calculada uma vez por consulta) e o campo computado ultimo_status_de_saida para o tique da prévia na lista
--
-- Medido em produção (Estallo, 30/10/2026): ~5.000 respostas 500 do PostgREST em
-- /rest/v1/conversations em 8 horas, todas "canceling statement due to statement
-- timeout". As contagens das abas da inbox (HEAD count) tinham média de 3,6 a
-- 4,6 s sobre uma tabela de 173 conversas. A policy `conversations_select` chamava
-- `fn_can_view_conversation` POR LINHA — SECURITY DEFINER, não inline-ável — e ela
-- chamava `fn_user_role_in_org` duas vezes, cada uma rodando `fn_support_context()`
-- (join com auth.sessions e auth.mfa_factors). `messages_select` faz EXISTS em
-- `conversations` por mensagem e herdava o custo. Era o toast "ID: …" que os
-- atendentes viam a cada mensagem recebida (o realtime refaz lista e contagens).
--
-- O QUE NÃO MUDA: quem vê qual conversa. `fn_can_view_conversation` tem a MESMA
-- regra de `fn_can_view_lead` (admin de plataforma; sem papel não vê; viewer,
-- manager e admin veem; responsável vê; senão a `visibility_mode` da organização),
-- então reusa os conjuntos da 0661, que entram como `in (select ...)` e são
-- avaliados uma vez por consulta. `fn_can_view_conversation` continua existindo
-- para quem a chama fora de policy.

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_veem_todos_os_negocios())
    or (
      assigned_to_user_id = (select auth.uid())
      and organization_id in (select public.fn_user_org_ids())
    )
    or (
      assigned_to_user_id is null
      and organization_id in (select public.fn_orgs_veem_negocios_sem_dono())
    )
  );

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select using (
    (select public.fn_is_platform_admin())
    or exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
    )
  );

drop policy if exists "message_templates_select" on public.message_templates;
create policy "message_templates_select" on public.message_templates
  for select using (
    (
      organization_id in (select public.fn_user_org_ids())
      and (owner_user_id is null or owner_user_id = (select auth.uid()))
    )
    or (select public.fn_is_platform_admin())
  );

-- Status da última mensagem de SAÍDA da conversa, para o tique da prévia na
-- lista da inbox (único/duplo/azul, como no WhatsApp). Campo computado do
-- PostgREST em vez de coluna: nada a sincronizar (DIRC: Calcular). SECURITY
-- INVOKER de propósito — a policy de `messages` decide o que o leitor vê.
-- Servido por `idx_messages_conversation_sent (conversation_id, sent_at desc)`.
create or replace function public.ultimo_status_de_saida(public.conversations)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select m.status
  from public.messages m
  where m.conversation_id = $1.id
    and m.direction = 'outbound'
  order by m.sent_at desc
  limit 1;
$$;

revoke execute on function public.ultimo_status_de_saida(public.conversations) from public, anon;
grant execute on function public.ultimo_status_de_saida(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
