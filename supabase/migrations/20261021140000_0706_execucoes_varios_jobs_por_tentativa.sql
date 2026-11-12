-- manifest: Liga varios jobs de turno a mesma tentativa de automacao (reenfileirar a classificacao por IA sem fechar a tentativa em voo)
-- Uma resposta do cliente que acorda o no cedo faz o motor reenfileirar o turno de classificacao
-- enquanto o job anterior segue na fila. `followup_execution_attempts.job_id` (0705) guarda UM job;
-- esta tabela guarda todos, de modo que o primeiro a concluir vence e os demais viram no-op,
-- como no motor legado. So ids: nada de dado pessoal, e some junto com a tentativa (cascade).
-- Fundacao da integracao do ai_classify. Nao habilita o contrato novo.
create table if not exists public.followup_execution_attempt_jobs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  attempt_id uuid not null,
  job_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, attempt_id, job_id),
  foreign key (organization_id, attempt_id) references public.followup_execution_attempts(organization_id, id) on delete cascade,
  foreign key (organization_id, job_id) references public.job_queue(organization_id, id) on delete cascade
);

create index if not exists followup_execution_attempt_jobs_job_idx
  on public.followup_execution_attempt_jobs (organization_id, job_id);

-- Quem ja tinha um job ligado pela 0705 passa a te-lo tambem aqui (idempotente).
insert into public.followup_execution_attempt_jobs (organization_id, attempt_id, job_id)
  select a.organization_id, a.id, a.job_id
  from public.followup_execution_attempts a
  where a.job_id is not null
  on conflict do nothing;

-- A sessao so le, e so manager+ (como as tentativas). Escrita e do motor.
alter table public.followup_execution_attempt_jobs enable row level security;
revoke all on table public.followup_execution_attempt_jobs from public, anon, authenticated;
grant select on table public.followup_execution_attempt_jobs to authenticated;
grant all on table public.followup_execution_attempt_jobs to service_role;

drop policy if exists followup_execution_attempt_jobs_select on public.followup_execution_attempt_jobs;
create policy followup_execution_attempt_jobs_select on public.followup_execution_attempt_jobs for select to authenticated
  using (organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
    and exists (select 1 from public.followup_execution_attempts a
      where a.id = followup_execution_attempt_jobs.attempt_id and a.organization_id = followup_execution_attempt_jobs.organization_id));
