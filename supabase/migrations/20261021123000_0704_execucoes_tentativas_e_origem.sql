-- manifest: Fixa a origem do contrato novo e registra o lease de cada tentativa para recusar workers obsoletos sem duplicar efeitos
-- Complemento da 0698; não ativa o executor e não muda inscrições legadas.

alter table public.followup_execution_attempts
  add column if not exists lease_revision bigint,
  add column if not exists lease_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.followup_execution_attempts'::regclass and conname = 'followup_execution_attempt_lease_check') then
    alter table public.followup_execution_attempts add constraint followup_execution_attempt_lease_check
      check (lease_revision is null or lease_revision >= 0);
  end if;
end;
$$;

create or replace function public.fn_followup_execution_origin_immutable()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.execution_contract is distinct from old.execution_contract or (old.execution_contract = 1 and (
    new.organization_id is distinct from old.organization_id
    or new.contact_id is distinct from old.contact_id
    or new.pointer_id is distinct from old.pointer_id
    or new.version_id is distinct from old.version_id
    or new.execution_contract is distinct from old.execution_contract
    or new.execution_mode is distinct from old.execution_mode
    or new.lead_id is distinct from old.lead_id
    or new.source_enrollment_id is distinct from old.source_enrollment_id
    or new.recovery_kind is distinct from old.recovery_kind
    or new.conversation_id is distinct from old.conversation_id
    or new.service_boundary is distinct from old.service_boundary
  )) then
    raise exception 'followup_execution_origin_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_followup_execution_origin_immutable() from public, anon, authenticated;
grant execute on function public.fn_followup_execution_origin_immutable() to service_role;

drop trigger if exists followup_execution_origin_immutable on public.followup_enrollments;
create trigger followup_execution_origin_immutable before update on public.followup_enrollments
  for each row execute function public.fn_followup_execution_origin_immutable();
