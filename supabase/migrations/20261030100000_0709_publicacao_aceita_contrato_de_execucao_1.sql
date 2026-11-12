-- manifest: A publicacao de fluxo passa a aceitar o contrato de execucao 1 (motor novo); qualquer outro valor de execution_contract continua recusado
-- Troca a guarda da 0707, que recusava a chave inteira enquanto o contrato estava desligado. O interruptor do
-- codigo (EXECUTION_CONTRACT_AVAILABLE) e o do banco andam juntos: esta migration e a que liga o banco.
-- Continua recusando valor desconhecido (so o 1 existe) para um chamador com service role nao gravar um contrato inventado.
create or replace function fn_publish_followup_flow_version(
  p_org uuid,
  p_pointer uuid,
  p_graph jsonb,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointer record;
  v_version_id uuid;
begin
  if p_graph ? 'execution_contract' and p_graph -> 'execution_contract' is distinct from '1'::jsonb then
    raise exception 'execution_contract_invalid' using errcode = 'P0001';
  end if;

  select p.id, p.organization_id
    into v_pointer
  from followup_flow_pointers p
  where p.id = p_pointer
  for update;

  if not found or v_pointer.organization_id <> p_org then
    raise exception 'pointer_not_found' using errcode = 'P0001';
  end if;

  insert into followup_flow_versions (organization_id, pointer_id, graph, created_by)
  values (p_org, p_pointer, p_graph, p_created_by)
  returning id into v_version_id;

  update followup_flow_pointers
     set active_version_id = v_version_id,
         status = 'active',
         updated_at = now()
   where id = p_pointer;

  return v_version_id;
end;
$$;
revoke all on function fn_publish_followup_flow_version(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function fn_publish_followup_flow_version(uuid, uuid, jsonb, uuid) to service_role;
