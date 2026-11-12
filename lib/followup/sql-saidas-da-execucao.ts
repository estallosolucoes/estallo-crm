/**
 * As saídas por bloco de uma execução — e, se ela é RECUPERAÇÃO (`recovery_kind = 'retry'`), as da cadeia de origem
 * antes (checkpoint herdado). Ordem: origem mais antiga primeiro, depois cada passo por entrada — quem vem depois
 * sobrescreve (o bloco que rodou de novo, a última volta de um laço). Passo concluído, última tentativa.
 */
export const SQL_SAIDAS_DA_EXECUCAO = `
  with recursive cadeia(id, nivel) as (
    select $2::uuid, 0
    union all
    select e.source_enrollment_id, c.nivel + 1
      from public.followup_enrollments e
      join cadeia c on e.id = c.id
     where e.organization_id = $1 and e.recovery_kind = 'retry' and e.source_enrollment_id is not null and c.nivel < 20
  )
  select s.node_id, a.output_snapshot
    from cadeia c
    join public.followup_execution_steps s on s.organization_id = $1 and s.enrollment_id = c.id
    join lateral (
      select output_snapshot from public.followup_execution_attempts
       where organization_id = s.organization_id and step_id = s.id
       order by attempt_no desc limit 1
    ) a on true
   where s.status = 'succeeded'
   order by c.nivel desc, s.entered_at asc
   limit 400`;
