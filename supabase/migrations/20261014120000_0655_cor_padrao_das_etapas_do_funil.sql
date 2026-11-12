-- manifest: **Etapa do funil nasce com cor.** Trigger `trg_crm_stages_cor_padrao` (BEFORE INSERT em `crm_stages`) sorteia uma cor da paleta de `lib/kanban/cor-da-etapa.ts` quando a etapa vem sem cor, diferente da etapa anterior do funil; backfill dá cor às etapas existentes em sequência pela ordem do funil. A cor vira a borda da coluna no quadro e é editável em Configurações › Funis.

-- ---- cor padrão das etapas do funil (migration 0655) ----
-- Etapa nova sem cor ganha uma da paleta (a mesma de lib/kanban/cor-da-etapa.ts),
-- diferente da etapa logo antes dela no funil. Trigger e não default no app:
-- etapa nasce por vários caminhos (rota, MCP, funções de onboarding/funil novo).
-- Só sorteio local — nenhum HTTP dentro da transação.
create or replace function public.fn_crm_stages_cor_padrao()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_paleta constant text[] := array[
    '#3b82f6','#06b6d4','#10b981','#84cc16','#eab308',
    '#f97316','#ef4444','#ec4899','#8b5cf6','#64748b'
  ];
  v_anterior text;
  v_opcoes text[];
begin
  if new.color is not null then
    return new;
  end if;
  -- Linhas anteriores do MESMO insert já são visíveis aqui (BEFORE ROW).
  select lower(s.color) into v_anterior
    from public.crm_stages s
   where s.pipeline_id = new.pipeline_id
     and s.is_archived = false
     and s.position < new.position
   order by s.position desc
   limit 1;
  select array_agg(c) into v_opcoes
    from unnest(v_paleta) as c
   where c is distinct from v_anterior;
  new.color := v_opcoes[1 + floor(random() * array_length(v_opcoes, 1))::int];
  return new;
end;
$$;

revoke execute on function public.fn_crm_stages_cor_padrao() from public, anon;

drop trigger if exists trg_crm_stages_cor_padrao on public.crm_stages;
create trigger trg_crm_stages_cor_padrao
  before insert on public.crm_stages
  for each row execute function public.fn_crm_stages_cor_padrao();

-- Backfill: etapas que já existiam sem cor recebem a paleta em sequência, pela
-- ordem do funil — vizinhas nunca repetem. Idempotente (só toca `color is null`).
with ordenadas as (
  select s.id,
         (row_number() over (partition by s.pipeline_id order by s.position, s.id) - 1) % 10 + 1 as i
    from public.crm_stages s
   where s.color is null
)
update public.crm_stages s
   set color = (array[
     '#3b82f6','#06b6d4','#10b981','#84cc16','#eab308',
     '#f97316','#ef4444','#ec4899','#8b5cf6','#64748b'
   ])[o.i]
  from ordenadas o
 where o.id = s.id;

