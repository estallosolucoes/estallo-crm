-- manifest: RLS de crm_leads (e das tabelas que a seguem) sem fn_can_view_lead por linha: a mesma visibilidade, calculada uma vez por consulta, porque a função por linha saturava o banco em funil grande
--
-- Medido em produção (Estallo, 15/10/2026, plano gratuito do Supabase): a leitura
-- do quadro de um funil com 1.135 negócios fazia `fn_can_view_lead` rodar uma vez
-- POR LINHA — função SECURITY DEFINER com SET search_path (o planner não a
-- inline-a), com 4 a 5 subconsultas cada. Em `crm_lead_products` ela rodava duas
-- vezes por linha (a policy chamava a função E consultava `crm_leads`, cuja
-- policy chama a mesma função): 3,2 s de média por lote de 100. O pico saturava o
-- banco a ponto de o `/auth/v1/user` de todos os usuários pendurar.
--
-- O QUE NÃO MUDA: quem vê qual negócio. `fn_can_view_lead` decide, nesta ordem:
--   1. admin de plataforma → vê
--   2. sem papel na organização → não vê
--   3. viewer, manager ou admin → vê
--   4. dono do negócio → vê
--   5. senão, pela `visibility_mode` da organização: 'all' → vê;
--      'own_and_unassigned' (o padrão) → só o sem dono; outro valor → não vê.
-- As funções abaixo devolvem CONJUNTOS de organizações para cada caso, sem
-- depender da linha — então entram como `in (select ...)`, que o Postgres avalia
-- uma vez por consulta (initplan) em vez de uma vez por linha. "Tem papel" é
-- exatamente `fn_user_org_ids()` (vínculo não revogado ou suporte ativo), o
-- mesmo universo em que `fn_user_role_in_org` devolve algo diferente de nulo.
--
-- `fn_can_view_lead` continua existindo: as policies de UPDATE/DELETE de
-- `crm_leads` a chamam só nas linhas afetadas, que são poucas.

create or replace function public.fn_orgs_veem_todos_os_negocios()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.id
  from public.organizations o
  where o.id in (select public.fn_user_org_ids())
    and (
      public.fn_user_role_in_org(o.id) in ('viewer', 'manager', 'admin')
      or coalesce(o.settings->>'visibility_mode', 'own_and_unassigned') = 'all'
    );
$$;

create or replace function public.fn_orgs_veem_negocios_sem_dono()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.id
  from public.organizations o
  where o.id in (select public.fn_user_org_ids())
    and coalesce(o.settings->>'visibility_mode', 'own_and_unassigned') = 'own_and_unassigned';
$$;

revoke execute on function public.fn_orgs_veem_todos_os_negocios() from public, anon;
grant execute on function public.fn_orgs_veem_todos_os_negocios() to authenticated, service_role;
revoke execute on function public.fn_orgs_veem_negocios_sem_dono() from public, anon;
grant execute on function public.fn_orgs_veem_negocios_sem_dono() to authenticated, service_role;

drop policy if exists crm_leads_select on public.crm_leads;
create policy crm_leads_select on public.crm_leads
  for select
  using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_veem_todos_os_negocios())
    or (
      owner_user_id = (select auth.uid())
      and organization_id in (select public.fn_user_org_ids())
    )
    or (
      owner_user_id is null
      and organization_id in (select public.fn_orgs_veem_negocios_sem_dono())
    )
  );

-- As tabelas que herdam a visibilidade do negócio passam a perguntar a
-- `crm_leads` — cuja policy acima já decide quem vê — em vez de chamar a função
-- de novo por linha. O admin de plataforma entra pela policy de `crm_leads`.
drop policy if exists crm_lead_products_select on public.crm_lead_products;
create policy crm_lead_products_select on public.crm_lead_products
  for select
  using (exists (select 1 from public.crm_leads l where l.id = crm_lead_products.lead_id));

drop policy if exists crm_lead_activities_select on public.crm_lead_activities;
create policy crm_lead_activities_select on public.crm_lead_activities
  for select
  using (exists (select 1 from public.crm_leads l where l.id = crm_lead_activities.lead_id));

drop policy if exists crm_lead_links_select on public.crm_lead_links;
create policy crm_lead_links_select on public.crm_lead_links
  for select
  using (exists (select 1 from public.crm_leads l where l.id = crm_lead_links.lead_id));

notify pgrst, 'reload schema';
