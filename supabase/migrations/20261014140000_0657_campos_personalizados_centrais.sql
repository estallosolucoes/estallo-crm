-- manifest: **Campos personalizados viram cadastro central da empresa.** Tabela `custom_field_definitions` (lead e contato; visibilidade global/por funil/por etapa; obrigatório na empresa ou em etapas, ao ganhar e ao perder; oculto) com RLS por organização (escrita admin). Backfill a partir de `crm_pipelines.settings.fields` (mesma chave em vários funis vira uma definição). `settings.fields` vira PROJEÇÃO dos campos de lead (`fn_projetar_campos_do_funil`, por trigger em definições, funis e etapas), o formato que validação de obrigatórios, captação, regras e IA já leem. Valores continuam em `crm_leads.custom_fields` e `contacts.custom_fields`.

-- ---- campos personalizados centrais da empresa (migration 0657) ----
-- A FONTE DA VERDADE dos campos personalizados passa a ser esta tabela: um
-- cadastro da empresa, para o LEAD e para o CONTATO, com visibilidade (global,
-- por funil ou por etapa), obrigatoriedade (em toda a empresa ou em etapas) e
-- a opção de ocultar sem apagar os valores.
--
-- `crm_pipelines.settings.fields` continua existindo como PROJEÇÃO dos campos de
-- lead (função `fn_projetar_campos_do_funil`, disparada por trigger): é o formato
-- que validação de obrigatórios, captação, regras, IA e telas já leem. Ninguém
-- escreve mais nele à mão — a tela de configurações e a captação gravam aqui.
-- Os VALORES não mudam de lugar: `crm_leads.custom_fields` e `contacts.custom_fields`.
create table if not exists public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entity text not null check (entity in ('lead', 'contact')),
  key text not null check (key ~ '^[A-Za-z][A-Za-z0-9_]*$' and length(key) <= 40),
  label text not null check (length(label) between 1 and 80),
  type text not null check (type in (
    'text','textarea','number','currency','date','select','multiselect',
    'boolean','email','phone','url'
  )),
  options jsonb not null default '[]'::jsonb,
  position numeric not null default 0,
  hidden boolean not null default false,
  visivel_global boolean not null default true,
  funis_visiveis uuid[] not null default '{}',
  etapas_visiveis uuid[] not null default '{}',
  obrigatorio text not null default 'nao' check (obrigatorio in ('nao', 'empresa', 'etapas')),
  etapas_obrigatorias uuid[] not null default '{}',
  obrigatorio_ao_ganhar boolean not null default false,
  obrigatorio_ao_perder boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, entity, key)
);

create index if not exists custom_field_definitions_org_idx
  on public.custom_field_definitions (organization_id, entity, position);

alter table public.custom_field_definitions enable row level security;

drop policy if exists tenant_isolation_custom_field_definitions_select on public.custom_field_definitions;
create policy tenant_isolation_custom_field_definitions_select on public.custom_field_definitions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_custom_field_definitions_all on public.custom_field_definitions;
create policy tenant_isolation_custom_field_definitions_all on public.custom_field_definitions
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

revoke all on public.custom_field_definitions from anon;
grant select, insert, update, delete on public.custom_field_definitions to authenticated;
grant all on public.custom_field_definitions to service_role;

drop trigger if exists trg_custom_field_definitions_updated_at on public.custom_field_definitions;
create trigger trg_custom_field_definitions_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.fn_set_updated_at();

-- Backfill: os campos que já viviam em cada funil viram definições da empresa.
-- A mesma chave em vários funis vira UMA definição, visível nos funis onde
-- estava (ou global, se estava em todos). Idempotente: `on conflict do nothing`.
with campos as (
  select p.organization_id,
         p.id as pipeline_id,
         p.position as funil_pos,
         f.ord,
         f.campo
    from public.crm_pipelines p
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p.settings -> 'fields') = 'array' then p.settings -> 'fields' else '[]'::jsonb end
    ) with ordinality as f(campo, ord)
   where (f.campo ->> 'key') ~ '^[A-Za-z][A-Za-z0-9_]*$'
     and length(f.campo ->> 'key') <= 40
     and coalesce(f.campo ->> 'label', '') <> ''
     and (f.campo ->> 'type') in ('text','textarea','number','currency','date','select',
                                  'multiselect','boolean','email','phone','url')
),
agregado as (
  select c.organization_id,
         c.campo ->> 'key' as key,
         (array_agg(c.campo order by c.funil_pos, c.ord))[1] as primeiro,
         min(c.ord) as ord,
         array_agg(distinct c.pipeline_id) as funis,
         bool_or(coalesce((c.campo -> 'obrigatorio_em' ->> 'ao_ganhar')::boolean, false)) as ao_ganhar,
         bool_or(coalesce((c.campo -> 'obrigatorio_em' ->> 'ao_perder')::boolean, false)) as ao_perder
    from campos c
   group by c.organization_id, c.campo ->> 'key'
),
etapas_obrig as (
  select c.organization_id, c.campo ->> 'key' as key, array_agg(distinct e::uuid) as etapas
    from campos c,
         jsonb_array_elements_text(
           case when jsonb_typeof(c.campo -> 'obrigatorio_em' -> 'etapas') = 'array'
                then c.campo -> 'obrigatorio_em' -> 'etapas' else '[]'::jsonb end) as e
   where e ~* '^[0-9a-f-]{36}$'
   group by c.organization_id, c.campo ->> 'key'
)
insert into public.custom_field_definitions (
  organization_id, entity, key, label, type, options, position,
  visivel_global, funis_visiveis, obrigatorio, etapas_obrigatorias,
  obrigatorio_ao_ganhar, obrigatorio_ao_perder
)
select a.organization_id, 'lead', a.key,
       left(a.primeiro ->> 'label', 80),
       a.primeiro ->> 'type',
       case when jsonb_typeof(a.primeiro -> 'options') = 'array' then a.primeiro -> 'options' else '[]'::jsonb end,
       a.ord * 1000,
       cardinality(a.funis) >= (select count(*) from public.crm_pipelines p where p.organization_id = a.organization_id),
       a.funis,
       case when cardinality(coalesce(eo.etapas, '{}')) > 0 then 'etapas' else 'nao' end,
       coalesce(eo.etapas, '{}'),
       a.ao_ganhar,
       a.ao_perder
  from agregado a
  left join etapas_obrig eo on eo.organization_id = a.organization_id and eo.key = a.key
on conflict (organization_id, entity, key) do nothing;

-- Uma definição de lead, no formato de `customFieldSchema`, para UM funil.
create or replace function public.fn_campo_projetado(d public.custom_field_definitions, p_pipeline uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'key', d.key,
    'label', d.label,
    'type', d.type,
    'options', case when jsonb_array_length(d.options) > 0 then d.options end,
    'required', case when d.obrigatorio <> 'nao' then true end,
    -- Visível só em algumas etapas DESTE funil: a lista vai junto; funil
    -- inteiro (ou global) não leva lista, e o formulário mostra sempre.
    'etapas_visiveis', case
      when d.visivel_global or p_pipeline = any(d.funis_visiveis) then null
      else (select jsonb_agg(s.id order by s.position)
              from public.crm_stages s
             where s.pipeline_id = p_pipeline and s.id = any(d.etapas_visiveis))
    end,
    'obrigatorio_em', case
      when d.obrigatorio = 'empresa' then jsonb_build_object(
        -- "Em toda a empresa": exigido ao sair da primeira etapa aberta e ao ganhar.
        'etapas', coalesce((
          select jsonb_agg(s.id order by s.position)
            from public.crm_stages s
           where s.pipeline_id = p_pipeline and not s.is_archived
             and not s.is_won and not s.is_lost
             and s.position > (select min(s2.position) from public.crm_stages s2
                                where s2.pipeline_id = p_pipeline and not s2.is_archived
                                  and not s2.is_won and not s2.is_lost)
        ), '[]'::jsonb),
        'ao_ganhar', true,
        'ao_perder', d.obrigatorio_ao_perder)
      when d.obrigatorio = 'etapas' or d.obrigatorio_ao_ganhar or d.obrigatorio_ao_perder then jsonb_build_object(
        'etapas', coalesce((
          select jsonb_agg(s.id order by s.position)
            from public.crm_stages s
           where s.pipeline_id = p_pipeline and s.id = any(d.etapas_obrigatorias)
        ), '[]'::jsonb),
        'ao_ganhar', d.obrigatorio_ao_ganhar,
        'ao_perder', d.obrigatorio_ao_perder)
    end
  ));
$$;

revoke execute on function public.fn_campo_projetado(public.custom_field_definitions, uuid) from public, anon;

-- Reescreve `settings.fields` de cada funil da empresa a partir das definições
-- de LEAD não ocultas que valem para ele. Só grava onde mudou.
create or replace function public.fn_projetar_campos_do_funil(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_fields jsonb;
begin
  for r in select p.id, p.settings from public.crm_pipelines p where p.organization_id = p_org loop
    select coalesce(jsonb_agg(public.fn_campo_projetado(d, r.id) order by d.position, d.created_at), '[]'::jsonb)
      into v_fields
      from public.custom_field_definitions d
     where d.organization_id = p_org
       and d.entity = 'lead'
       and not d.hidden
       and (d.visivel_global
            or r.id = any(d.funis_visiveis)
            or exists (select 1 from public.crm_stages s
                        where s.pipeline_id = r.id and s.id = any(d.etapas_visiveis)));
    if (r.settings -> 'fields') is distinct from v_fields then
      update public.crm_pipelines
         set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('fields', v_fields)
       where id = r.id;
    end if;
  end loop;
end;
$$;

revoke execute on function public.fn_projetar_campos_do_funil(uuid) from public, anon, authenticated;
grant execute on function public.fn_projetar_campos_do_funil(uuid) to service_role;

create or replace function public.fn_trg_projetar_campos_do_funil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
  else
    v_org := new.organization_id;
  end if;
  -- Mudou uma definição: projeta sempre (inclusive para LIMPAR a última).
  -- Mudou funil ou etapa: só projeta se a empresa já usa o cadastro central —
  -- sem definições, `settings.fields` de quem nunca o usou fica como estava.
  if tg_table_name = 'custom_field_definitions'
     or exists (select 1 from public.custom_field_definitions d
                 where d.organization_id = v_org and d.entity = 'lead') then
    perform public.fn_projetar_campos_do_funil(v_org);
  end if;
  return null;
end;
$$;

revoke execute on function public.fn_trg_projetar_campos_do_funil() from public, anon, authenticated;

drop trigger if exists trg_custom_field_definitions_projeta on public.custom_field_definitions;
create trigger trg_custom_field_definitions_projeta
  after insert or update or delete on public.custom_field_definitions
  for each row execute function public.fn_trg_projetar_campos_do_funil();

drop trigger if exists trg_crm_pipelines_projeta_campos on public.crm_pipelines;
create trigger trg_crm_pipelines_projeta_campos
  after insert on public.crm_pipelines
  for each row execute function public.fn_trg_projetar_campos_do_funil();

drop trigger if exists trg_crm_stages_projeta_campos on public.crm_stages;
create trigger trg_crm_stages_projeta_campos
  after insert or update of position, is_archived, is_won, is_lost on public.crm_stages
  for each row execute function public.fn_trg_projetar_campos_do_funil();

