-- manifest: A inscricao nasce no contrato de execucao da versao fixada (motor novo) e com o lead explicito congelado na criacao
-- Todo ponto de criacao de inscricao (manual, varredura de silencio e os gatilhos) grava version_id; este gatilho
-- copia execution_contract do grafo dessa versao e fixa lead_id no negocio mais recente do contato, a mesma escolha
-- que o motor antigo refazia a cada passo. So age em inscricao nascida no contrato 0 sobre versao de contrato 1:
-- linha que ja traz contrato 1 (ou lead explicito) fica como veio. Sem HTTP: apenas leitura de duas tabelas.
create or replace function public.fn_enrollment_herda_contrato_da_versao()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_contract int;
begin
  if new.execution_contract <> 0 then
    return new;
  end if;

  select (v.graph ->> 'execution_contract')::int
    into v_contract
  from followup_flow_versions v
  where v.organization_id = new.organization_id
    and v.id = new.version_id;

  if v_contract is distinct from 1 then
    return new;
  end if;

  new.execution_contract := 1;
  if new.lead_id is null then
    select l.id
      into new.lead_id
    from crm_leads l
    where l.organization_id = new.organization_id
      and l.contact_id = new.contact_id
    order by l.updated_at desc, l.id
    limit 1;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_enrollment_herda_contrato_da_versao() from public, anon, authenticated;

drop trigger if exists trg_enrollment_herda_contrato_da_versao on public.followup_enrollments;
create trigger trg_enrollment_herda_contrato_da_versao
  before insert on public.followup_enrollments
  for each row execute function public.fn_enrollment_herda_contrato_da_versao();
