-- manifest: Vincula a tentativa da automação ao job real, com FK por organização e preservação do histórico após retenção da fila
-- Fundação da integração assíncrona. Não habilita o contrato novo.
create unique index if not exists job_queue_org_id_key on public.job_queue(organization_id,id);

alter table public.followup_execution_attempts add column if not exists job_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.followup_execution_attempts'::regclass and conname='followup_execution_attempt_job_fk') then
    alter table public.followup_execution_attempts add constraint followup_execution_attempt_job_fk
      foreign key (organization_id,job_id) references public.job_queue(organization_id,id)
      on delete set null (job_id);
  end if;
end;
$$;

create index if not exists followup_execution_attempts_job_idx
  on public.followup_execution_attempts(organization_id,job_id) where job_id is not null;
