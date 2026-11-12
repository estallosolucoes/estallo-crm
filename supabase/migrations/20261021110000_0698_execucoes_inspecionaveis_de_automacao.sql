-- manifest: Registra passagens, tentativas e efeitos de automações para inspeção e recuperação, com alvo explícito de lead e isolamento por organização
-- Fundação aditiva. Execuções existentes permanecem no contrato 0; nada é ativado por esta migration.

alter table public.followup_enrollments
  add column if not exists execution_contract smallint not null default 0,
  add column if not exists execution_mode text not null default 'production',
  add column if not exists lead_id uuid,
  add column if not exists source_enrollment_id uuid,
  add column if not exists recovery_kind text;

create unique index if not exists followup_enrollments_org_id_key
  on public.followup_enrollments (organization_id, id);
create unique index if not exists followup_enrollments_org_contact_id_key
  on public.followup_enrollments (organization_id, contact_id, id);
create unique index if not exists crm_leads_org_contact_id_key
  on public.crm_leads (organization_id, contact_id, id);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_enrollments'::regclass and conname = 'followup_execution_contract_check') then
    alter table public.followup_enrollments add constraint followup_execution_contract_check check (execution_contract in (0, 1));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_enrollments'::regclass and conname = 'followup_execution_mode_check') then
    alter table public.followup_enrollments add constraint followup_execution_mode_check check (execution_mode in ('production', 'simulation', 'test'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_enrollments'::regclass and conname = 'followup_execution_lead_fk') then
    alter table public.followup_enrollments add constraint followup_execution_lead_fk
      foreign key (organization_id, contact_id, lead_id) references public.crm_leads (organization_id, contact_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_enrollments'::regclass and conname = 'followup_execution_source_fk') then
    alter table public.followup_enrollments add constraint followup_execution_source_fk
      foreign key (organization_id, contact_id, source_enrollment_id) references public.followup_enrollments (organization_id, contact_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_enrollments'::regclass and conname = 'followup_execution_recovery_check') then
    alter table public.followup_enrollments add constraint followup_execution_recovery_check
      check ((source_enrollment_id is null and recovery_kind is null)
        or (source_enrollment_id is not null and source_enrollment_id <> id and recovery_kind is not null and recovery_kind in ('retry', 'restart')));
  end if;
end;
$$;

create index if not exists followup_enrollments_flow_history_idx
  on public.followup_enrollments (organization_id, pointer_id, started_at desc, id desc);
create index if not exists followup_enrollments_lead_history_idx
  on public.followup_enrollments (organization_id, lead_id, started_at desc, id desc)
  where lead_id is not null;
create index if not exists followup_enrollments_source_idx
  on public.followup_enrollments (organization_id, source_enrollment_id)
  where source_enrollment_id is not null;
create index if not exists followup_enrollments_execution_retention_idx
  on public.followup_enrollments (completed_at, id)
  where execution_contract = 1 and status in ('completed', 'cancelled', 'dead');
create index if not exists followup_enrollments_inspectable_idx
  on public.followup_enrollments (organization_id, id) where execution_contract = 1;

create table if not exists public.followup_execution_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null,
  node_id text not null check (length(node_id) between 1 and 128),
  visit integer not null check (visit >= 0),
  iteration integer not null default 0 check (iteration >= 0),
  status text not null default 'pending' check (status in ('pending', 'running', 'waiting', 'succeeded', 'skipped', 'failed', 'unknown')),
  branch_id text,
  entered_at timestamptz not null default now(),
  completed_at timestamptz,
  inherited_from_step_id uuid,
  unique (organization_id, id),
  unique (organization_id, enrollment_id, id),
  unique (organization_id, enrollment_id, node_id, visit),
  foreign key (organization_id, enrollment_id) references public.followup_enrollments(organization_id, id) on delete cascade,
  foreign key (organization_id, inherited_from_step_id) references public.followup_execution_steps(organization_id, id),
  check (completed_at is null or completed_at >= entered_at),
  check ((status in ('pending', 'running', 'waiting')) = (completed_at is null))
);

create index if not exists followup_execution_steps_order_idx
  on public.followup_execution_steps (organization_id, enrollment_id, entered_at, id);
create index if not exists followup_execution_steps_inherited_idx
  on public.followup_execution_steps (organization_id, inherited_from_step_id)
  where inherited_from_step_id is not null;

create table if not exists public.followup_execution_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  step_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  contract_version smallint not null default 1 check (contract_version = 1),
  status text not null check (status in ('running', 'waiting', 'succeeded', 'skipped', 'failed', 'unknown')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  input_snapshot jsonb,
  config_snapshot jsonb,
  output_snapshot jsonb,
  output_recorded boolean not null default false,
  error_snapshot jsonb,
  request_id text,
  next_eval_at timestamptz,
  payload_expires_at timestamptz,
  payload_expired_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, step_id, attempt_no),
  foreign key (organization_id, step_id) references public.followup_execution_steps(organization_id, id) on delete cascade,
  check (completed_at is null or completed_at >= started_at),
  check ((status in ('running', 'waiting')) = (completed_at is null)),
  check (status <> 'succeeded' or output_recorded),
  check (status not in ('failed', 'unknown') or error_snapshot is not null or payload_expired_at is not null),
  check (status not in ('succeeded', 'skipped') or error_snapshot is null)
);

create index if not exists followup_execution_attempts_expiry_idx
  on public.followup_execution_attempts (payload_expires_at)
  where payload_expires_at is not null and payload_expired_at is null;

create table if not exists public.followup_execution_effects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null,
  step_id uuid not null,
  effect_key text not null check (length(effect_key) between 1 and 2048),
  operation text not null check (length(operation) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'unknown')),
  result_snapshot jsonb,
  external_ref text,
  payload_expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, effect_key),
  foreign key (organization_id, enrollment_id) references public.followup_enrollments(organization_id, id) on delete cascade,
  foreign key (organization_id, enrollment_id, step_id) references public.followup_execution_steps(organization_id, enrollment_id, id) on delete cascade,
  check (status <> 'confirmed' or result_snapshot is not null or payload_expired_at is not null)
);

create index if not exists followup_execution_effects_step_idx
  on public.followup_execution_effects (organization_id, step_id);

-- A sessão só lê. Estado, snapshots e recibos são escritos pelo motor; não pelo browser.
-- Tentativas e efeitos incluem detalhes técnicos protegidos, portanto exigem manager+.
alter table public.followup_execution_steps enable row level security;
alter table public.followup_execution_attempts enable row level security;
alter table public.followup_execution_effects enable row level security;

revoke all on table public.followup_execution_steps from public, anon, authenticated;
revoke all on table public.followup_execution_attempts from public, anon, authenticated;
revoke all on table public.followup_execution_effects from public, anon, authenticated;
grant select on table public.followup_execution_steps to authenticated;
grant select on table public.followup_execution_attempts to authenticated;
grant select on table public.followup_execution_effects to authenticated;
grant all on table public.followup_execution_steps to service_role;
grant all on table public.followup_execution_attempts to service_role;
grant all on table public.followup_execution_effects to service_role;

drop policy if exists followup_execution_steps_select on public.followup_execution_steps;
create policy followup_execution_steps_select on public.followup_execution_steps for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and exists (
    select 1 from public.followup_enrollments e
    where e.id = followup_execution_steps.enrollment_id and e.organization_id = followup_execution_steps.organization_id
      and (e.lead_id is null or exists (select 1 from public.crm_leads l where l.id = e.lead_id and l.organization_id = e.organization_id))
  ));

drop policy if exists followup_execution_attempts_select on public.followup_execution_attempts;
create policy followup_execution_attempts_select on public.followup_execution_attempts for select to authenticated
  using (organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
    and exists (select 1 from public.followup_execution_steps s where s.id = followup_execution_attempts.step_id and s.organization_id = followup_execution_attempts.organization_id));

drop policy if exists followup_execution_effects_select on public.followup_execution_effects;
create policy followup_execution_effects_select on public.followup_execution_effects for select to authenticated
  using (organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
    and exists (select 1 from public.followup_execution_steps s where s.id = followup_execution_effects.step_id and s.organization_id = followup_execution_effects.organization_id));

-- A política é da organização, não do ambiente. Valores inválidos recaem no
-- padrão inteiro, com indicação explícita para a superfície de configuração.
create or replace function public.fn_followup_retention_policy(
  p_org uuid, p_payload_default integer default 30, p_metadata_default integer default 180
)
returns table (payload_days integer, metadata_days integer, configuration_valid boolean)
language plpgsql stable set search_path = public
as $$
declare
  config jsonb;
  payload integer := least(365, greatest(1, coalesce(p_payload_default, 30)));
  metadata integer := least(1825, greatest(30, coalesce(p_metadata_default, 180)));
  fallback_payload integer;
  fallback_metadata integer;
  valid boolean := true;
begin
  metadata := greatest(payload, metadata);
  fallback_payload := payload;
  fallback_metadata := metadata;
  select o.settings #> '{automations,retention}' into config from public.organizations o where o.id = p_org;
  if config is null then
    return query select payload, metadata, true;
    return;
  end if;
  if jsonb_typeof(config) <> 'object' then
    return query select fallback_payload, fallback_metadata, false;
    return;
  end if;
  if exists (select 1 from jsonb_object_keys(config) as k(key) where k.key not in ('payload_days', 'metadata_days')) then
    valid := false;
  end if;
  if config ? 'payload_days' then
    if jsonb_typeof(config->'payload_days') = 'number' then
      if (config->>'payload_days')::numeric between 1 and 365
        and trunc((config->>'payload_days')::numeric) = (config->>'payload_days')::numeric then
        payload := (config->>'payload_days')::numeric::integer;
      else
        valid := false;
      end if;
    else
      valid := false;
    end if;
  end if;
  if config ? 'metadata_days' then
    if jsonb_typeof(config->'metadata_days') = 'number' then
      if (config->>'metadata_days')::numeric between 30 and 1825
        and trunc((config->>'metadata_days')::numeric) = (config->>'metadata_days')::numeric then
        metadata := (config->>'metadata_days')::numeric::integer;
      else
        valid := false;
      end if;
    else
      valid := false;
    end if;
  end if;
  valid := valid and metadata >= payload;
  if not valid then
    return query select fallback_payload, fallback_metadata, false;
  else
    return query select payload, metadata, true;
  end if;
end;
$$;
revoke all on function public.fn_followup_retention_policy(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_followup_retention_policy(uuid, integer, integer) to service_role;

create or replace function public.fn_set_followup_retention_policy(p_org uuid, p_policy jsonb)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  previous_settings jsonb;
  valid boolean;
begin
  select o.settings into previous_settings from public.organizations o where o.id = p_org for update;
  if not found then return false; end if;
  if previous_settings is not null and jsonb_typeof(previous_settings) <> 'object' then
    raise exception 'invalid_organization_settings' using errcode = '22023';
  end if;
  update public.organizations
    set settings = coalesce(previous_settings, '{}'::jsonb) || jsonb_build_object(
      'automations',
      (case when jsonb_typeof(previous_settings->'automations') = 'object'
        then previous_settings->'automations' else '{}'::jsonb end)
      || jsonb_build_object('retention', p_policy)
    )
    where id = p_org;
  select p.configuration_valid into valid from public.fn_followup_retention_policy(p_org) p;
  if valid is not true then
    raise exception 'invalid_followup_retention_policy' using errcode = '22023';
  end if;
  return true;
end;
$$;
revoke all on function public.fn_set_followup_retention_policy(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_set_followup_retention_policy(uuid, jsonb) to service_role;

-- Uma execução viva protege toda a sua linhagem e os checkpoints herdados.
create or replace function public.fn_followup_protected_execution_ids()
returns setof uuid language sql stable set search_path = public
as $$
  with recursive dependencies as (
    select e.id as child, e.source_enrollment_id as parent
    from public.followup_enrollments e where e.source_enrollment_id is not null
    union
    select child.enrollment_id, parent.enrollment_id
    from public.followup_execution_steps child
    join public.followup_execution_steps parent on parent.id = child.inherited_from_step_id
      and parent.organization_id = child.organization_id
  ), protected as (
    select e.id from public.followup_enrollments e
    where e.execution_contract = 1 and e.status not in ('completed', 'cancelled', 'dead')
    union
    select d.parent from dependencies d join protected p on p.id = d.child
  )
  select p.id from protected p;
$$;
revoke all on function public.fn_followup_protected_execution_ids() from public, anon, authenticated;
grant execute on function public.fn_followup_protected_execution_ids() to service_role;

-- A mesma limpeza atende prazo e anonimização. Metadados técnicos permanecem;
-- dados apagados nunca são apresentados como se fossem uma saída JSON null.
create or replace function public.fn_redigir_payloads_execucao(p_org uuid, p_enrollment uuid)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  attempts integer;
  effects integer;
begin
  update public.followup_execution_attempts a
    set input_snapshot = null, config_snapshot = null, output_snapshot = null,
        error_snapshot = null, payload_expired_at = coalesce(a.payload_expired_at, now())
  from public.followup_execution_steps s
  where s.id = a.step_id and s.organization_id = a.organization_id
    and s.organization_id = p_org and s.enrollment_id = p_enrollment
    and (a.payload_expired_at is null or a.input_snapshot is not null or a.config_snapshot is not null
      or a.output_snapshot is not null or a.error_snapshot is not null);
  get diagnostics attempts = row_count;
  update public.followup_execution_effects e
    set result_snapshot = null, external_ref = null,
        payload_expired_at = coalesce(e.payload_expired_at, now()), updated_at = now()
  where e.organization_id = p_org and e.enrollment_id = p_enrollment
    and (e.payload_expired_at is null or e.result_snapshot is not null or e.external_ref is not null);
  get diagnostics effects = row_count;
  return attempts + effects;
end;
$$;
revoke all on function public.fn_redigir_payloads_execucao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_redigir_payloads_execucao(uuid, uuid) to service_role;

-- Escrita tardia respeita anonimização e expurgo. A marca de expiração é
-- permanente: callbacks não podem repor dados nem apagar a marca. FOR SHARE serializa com a
-- atualização do contato; não basta ler is_anonymized por um snapshot antigo.
create or replace function public.fn_followup_snapshot_privacy_guard()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  anonymized boolean;
begin
  select c.is_anonymized into anonymized
  from public.followup_execution_steps s
  join public.followup_enrollments e on e.id = s.enrollment_id and e.organization_id = s.organization_id
  join public.contacts c on c.id = e.contact_id and c.organization_id = e.organization_id
  where s.id = new.step_id and s.organization_id = new.organization_id
  for share of c;
  if tg_op = 'UPDATE' then
    if old.payload_expired_at is not null then
      new.payload_expired_at := old.payload_expired_at;
    end if;
  end if;
  if anonymized is true or new.payload_expired_at is not null then
    new.payload_expired_at := coalesce(new.payload_expired_at, now());
    if tg_table_name = 'followup_execution_attempts' then
      new.input_snapshot := null;
      new.config_snapshot := null;
      new.output_snapshot := null;
      new.error_snapshot := null;
    else
      new.result_snapshot := null;
      new.external_ref := null;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_followup_snapshot_privacy_guard() from public, anon, authenticated;
grant execute on function public.fn_followup_snapshot_privacy_guard() to service_role;

drop trigger if exists followup_attempts_privacy_guard on public.followup_execution_attempts;
create trigger followup_attempts_privacy_guard before insert or update on public.followup_execution_attempts
  for each row execute function public.fn_followup_snapshot_privacy_guard();
drop trigger if exists followup_effects_privacy_guard on public.followup_execution_effects;
create trigger followup_effects_privacy_guard before insert or update on public.followup_execution_effects
  for each row execute function public.fn_followup_snapshot_privacy_guard();

create or replace function public.fn_redigir_execucoes_ao_anonimizar_contato()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  enrollment uuid;
begin
  for enrollment in
    select e.id from public.followup_enrollments e
    where e.organization_id = new.organization_id and e.contact_id = new.id
  loop
    perform public.fn_redigir_payloads_execucao(new.organization_id, enrollment);
  end loop;
  return new;
end;
$$;
revoke all on function public.fn_redigir_execucoes_ao_anonimizar_contato() from public, anon, authenticated;
grant execute on function public.fn_redigir_execucoes_ao_anonimizar_contato() to service_role;
drop trigger if exists followup_redigir_ao_anonimizar on public.contacts;
create trigger followup_redigir_ao_anonimizar after update of is_anonymized on public.contacts
  for each row when (new.is_anonymized is true)
  execute function public.fn_redigir_execucoes_ao_anonimizar_contato();

-- Contagens são de EXECUÇÕES, não de linhas de snapshot. Retry deve bloquear
-- a execução original antes de validar a disponibilidade do checkpoint.
create or replace function public.fn_expurgar_payloads_de_automacao(p_retencao_dias integer default 30, p_limite integer default 1000)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  row_to_scrub record;
  changed integer := 0;
begin
  for row_to_scrub in
    select e.id, e.organization_id
    from public.followup_enrollments e
    cross join lateral public.fn_followup_retention_policy(e.organization_id, p_retencao_dias, 180) policy
    where e.execution_contract = 1 and e.status in ('completed', 'cancelled', 'dead')
      and e.completed_at < now() - make_interval(days => policy.payload_days)
      and (e.claimed_until is null or e.claimed_until <= now())
      and e.id not in (select public.fn_followup_protected_execution_ids())
      and (exists (
        select 1 from public.followup_execution_attempts a
        join public.followup_execution_steps s on s.id = a.step_id and s.organization_id = a.organization_id
        where s.enrollment_id = e.id and s.organization_id = e.organization_id and a.payload_expired_at is null
      ) or exists (
        select 1 from public.followup_execution_effects effect
        where effect.enrollment_id = e.id and effect.organization_id = e.organization_id and effect.payload_expired_at is null
      ))
    order by e.completed_at, e.id
    limit least(1000, greatest(1, coalesce(p_limite, 1000)))
    for update of e skip locked
  loop
    perform public.fn_redigir_payloads_execucao(row_to_scrub.organization_id, row_to_scrub.id);
    changed := changed + 1;
  end loop;
  return changed;
end;
$$;
revoke all on function public.fn_expurgar_payloads_de_automacao(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_expurgar_payloads_de_automacao(integer, integer) to service_role;

create or replace function public.fn_expurgar_execucoes_de_automacao(p_retencao_dias integer default 180, p_limite integer default 1000)
returns integer language plpgsql security definer set search_path = public
as $$
declare
  removed integer := 0;
  batch integer;
  budget integer := least(1000, greatest(1, coalesce(p_limite, 1000)));
begin
  loop
  with expired as (
    select e.id, e.organization_id from public.followup_enrollments e
    cross join lateral public.fn_followup_retention_policy(e.organization_id, 30, p_retencao_dias) policy
    where e.execution_contract = 1 and e.status in ('completed', 'cancelled', 'dead')
      and e.completed_at < now() - make_interval(days => policy.metadata_days)
      and (e.claimed_until is null or e.claimed_until <= now())
      and e.id not in (select public.fn_followup_protected_execution_ids())
      and not exists (select 1 from public.followup_enrollments child where child.organization_id = e.organization_id and child.source_enrollment_id = e.id)
      and not exists (
        select 1 from public.followup_execution_steps parent
        join public.followup_execution_steps child on child.inherited_from_step_id = parent.id and child.organization_id = parent.organization_id
        where parent.enrollment_id = e.id and parent.organization_id = e.organization_id and child.enrollment_id <> e.id
      )
    order by e.completed_at, e.id
    limit budget - removed
    for update of e skip locked
  )
  delete from public.followup_enrollments e using expired x
  where e.id = x.id and e.organization_id = x.organization_id;
  get diagnostics batch = row_count;
  removed := removed + batch;
  -- Filhos vencidos liberam os pais. O lote só termina quando não há mais
  -- elegíveis ou esgota a cota; não deixa resto silencioso por causa da FK.
  exit when batch = 0 or removed >= budget;
  end loop;
  return removed;
end;
$$;
revoke all on function public.fn_expurgar_execucoes_de_automacao(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_expurgar_execucoes_de_automacao(integer, integer) to service_role;
