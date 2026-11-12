-- manifest: produtos no negócio (crm_lead_products) com desconto por item; o valor do negócio passa a ser a soma dos itens, recalculada por trigger
--
-- Estallo: o card do lead escolhe produtos do catálogo; o preço vem do produto e
-- o desconto (em centavos, por item) abate do total. `crm_leads.value_cents` é
-- CALCULADO daqui por trigger — uma fonte só, seja quem for que mexa nos itens
-- (tela, API ou MCP). Nome e preço são COPIADOS na hora de vincular: mudar o
-- preço do catálogo depois não reescreve negócio já montado, e apagar o produto
-- não apaga o histórico (`product_id` vira nulo, o item fica).

create table if not exists public.crm_lead_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  product_id uuid references public.catalog_products(id) on delete set null,
  nome text not null,
  quantidade integer not null default 1,
  preco_unitario_cents bigint not null,
  desconto_cents bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_products_quantidade_positiva check (quantidade > 0),
  constraint crm_lead_products_preco_nao_negativo check (preco_unitario_cents >= 0),
  constraint crm_lead_products_desconto_nao_negativo check (desconto_cents >= 0)
);

create index if not exists crm_lead_products_lead_idx
  on public.crm_lead_products (organization_id, lead_id);
-- O filtro por produto no quadro do funil.
create index if not exists crm_lead_products_produto_idx
  on public.crm_lead_products (organization_id, product_id);

alter table public.crm_lead_products enable row level security;

-- Leitura: quem vê o negócio vê os itens dele (molde de crm_lead_links).
drop policy if exists crm_lead_products_select on public.crm_lead_products;
create policy crm_lead_products_select on public.crm_lead_products
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_products.lead_id
        and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
    or (select public.fn_is_platform_admin())
  );

-- Escrita: `agent` para cima, e o negócio precisa ser da MESMA organização.
drop policy if exists crm_lead_products_insert on public.crm_lead_products;
create policy crm_lead_products_insert on public.crm_lead_products
  for insert with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and exists (
          select 1 from public.crm_leads l
          where l.id = crm_lead_products.lead_id
            and l.organization_id = crm_lead_products.organization_id
        ))
  );

drop policy if exists crm_lead_products_update on public.crm_lead_products;
create policy crm_lead_products_update on public.crm_lead_products
  for update using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists crm_lead_products_delete on public.crm_lead_products;
create policy crm_lead_products_delete on public.crm_lead_products
  for delete using (
    (select public.fn_is_platform_admin_full())
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.crm_lead_products from anon;
grant select, insert, update, delete on public.crm_lead_products to authenticated;
grant all on public.crm_lead_products to service_role;

drop trigger if exists trg_crm_lead_products_updated_at on public.crm_lead_products;
create trigger trg_crm_lead_products_updated_at
  before update on public.crm_lead_products
  for each row execute function public.fn_set_updated_at();

-- O valor do negócio = soma de (quantidade × preço − desconto), nunca negativa
-- por item. Invoker de propósito: quem mexe no item precisa poder mexer no
-- negócio, e a RLS de crm_leads continua valendo. Sem HTTP (anti-pattern 9).
create or replace function public.fn_crm_lead_products_recalcula_valor()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.crm_leads l
     set value_cents = coalesce((
           select sum(greatest(p.quantidade * p.preco_unitario_cents - p.desconto_cents, 0))
             from public.crm_lead_products p
            where p.lead_id = v_lead
         ), 0)
   where l.id = v_lead;
  -- Item trocado de negócio (não há rota para isso, mas o UPDATE permite):
  -- o negócio antigo também se recalcula.
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    update public.crm_leads l
       set value_cents = coalesce((
             select sum(greatest(p.quantidade * p.preco_unitario_cents - p.desconto_cents, 0))
               from public.crm_lead_products p
              where p.lead_id = old.lead_id
           ), 0)
     where l.id = old.lead_id;
  end if;
  return null;
end
$$;

revoke execute on function public.fn_crm_lead_products_recalcula_valor() from public, anon;
grant execute on function public.fn_crm_lead_products_recalcula_valor() to authenticated, service_role;

drop trigger if exists trg_crm_lead_products_recalcula_valor on public.crm_lead_products;
create trigger trg_crm_lead_products_recalcula_valor
  after insert or update or delete on public.crm_lead_products
  for each row execute function public.fn_crm_lead_products_recalcula_valor();

comment on table public.crm_lead_products is
  'Produtos do negócio (Estallo, 0660): nome e preço copiados do catálogo; o valor do negócio é a soma dos itens menos o desconto.';

-- As travas do suporte somente leitura alcançam a tabela nova (0274).
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
