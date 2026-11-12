-- manifest: Categorias do Inbox por última entrada/saída, filtráveis antes da paginação sem mudar o atendimento.

-- Campo calculado, SECURITY INVOKER: só lê a linha já visível pela RLS.
-- Parâmetro sem nome impede expor um RPC para esta função de apresentação.
create or replace function public.status_do_chat(public.conversations)
returns text language sql immutable security invoker set search_path = '' as $$
  select case
    when $1.status in ('closed', 'archived') then 'fechadas'
    when $1.is_group then null
    when $1.last_inbound_at is not null and $1.last_outbound_at is null then 'sem_resposta'
    when $1.last_outbound_at is not null and $1.last_inbound_at > $1.last_outbound_at then 'em_espera'
    when $1.last_outbound_at is not null then 'em_aberto'
    else null
  end;
$$;
revoke execute on function public.status_do_chat(public.conversations) from public, anon;
grant execute on function public.status_do_chat(public.conversations) to authenticated, service_role;

-- Organização primeiro: o índice atende os filtros e a ordem nos dois sentidos.
create index if not exists idx_conversations_org_status_chat_message
  on public.conversations (organization_id, public.status_do_chat(conversations), last_message_at desc nulls last, id desc);

notify pgrst, 'reload schema';
