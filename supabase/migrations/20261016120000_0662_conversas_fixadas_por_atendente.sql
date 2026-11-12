-- manifest: conversation_pins — cada atendente fixa as suas conversas no topo do Inbox, sem mexer na lista dos outros
--
-- Estallo (16/10/2026): o menu de cada conversa ganhou "Fixar conversa". Fixar é
-- preferência de QUEM USA, não estado da conversa: o que um atendente fixa não
-- pode empurrar a lista do colega. Por isso uma tabela por (usuário, conversa), e
-- não uma coluna em `conversations`.
--
-- RLS: cada um lê, cria e apaga só as próprias linhas, e só nas organizações de
-- que é membro. Apagar a conversa, o usuário ou a organização leva o pin junto.

create table if not exists public.conversation_pins (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);

create index if not exists conversation_pins_org_user_idx
  on public.conversation_pins (organization_id, user_id, pinned_at desc);

alter table public.conversation_pins enable row level security;

drop policy if exists conversation_pins_select on public.conversation_pins;
create policy conversation_pins_select on public.conversation_pins
  for select using (
    user_id = (select auth.uid())
    and organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists conversation_pins_insert on public.conversation_pins;
create policy conversation_pins_insert on public.conversation_pins
  for insert with check (
    user_id = (select auth.uid())
    and organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_pins.conversation_id
        and c.organization_id = conversation_pins.organization_id
    )
  );

drop policy if exists conversation_pins_delete on public.conversation_pins;
create policy conversation_pins_delete on public.conversation_pins
  for delete using (
    user_id = (select auth.uid())
    and organization_id in (select public.fn_user_org_ids())
  );

revoke all on table public.conversation_pins from anon;
grant select, insert, delete on table public.conversation_pins to authenticated;
grant all on table public.conversation_pins to service_role;
