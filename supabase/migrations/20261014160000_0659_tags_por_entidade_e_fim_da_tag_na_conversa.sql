-- manifest: Tags por entidade (lead/contato) no vocabulário, criar/editar/excluir escopados por entidade, excluir tira SÓ a etiqueta pedida, e conversa deixa de ter tag (dados apagados, coluna travada vazia).
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
-- 1. `fn_tags_normalizar` com remover=true apagava TODAS as etiquetas do
--    registro (o `case when p_remover then null` não olhava o nome). Excluir
--    "vip" de um contato `{vip, obra}` deixava `{}`. Agora sai só a pedida.
-- 2. Cada entrada de `organizations.settings.tags` ganha `entidade`
--    (`lead` | `contact`). A mesma etiqueta pode existir nas duas, cada uma com
--    sua cor. Backfill: a entrada antiga vira uma entrada por entidade onde a
--    etiqueta é USADA (registros, regras `add_tag` pelo destino, nós de
--    follow-up) — sem uso nenhum, vira as duas. Nada é apagado.
-- 3. `fn_vocabulario_de_tags` passa a devolver uma linha por (entidade, tag) e
--    não lê mais conversas. `fn_vocabulario_de_tags_operar` ganha `p_entidade`
--    e a ação `criar`; renomear/juntar/excluir só tocam a tabela da entidade e
--    as regras daquele destino (`contato` → contato; `card`/padrão → lead).
-- 4. Conversa não tem mais tag: os dados são apagados, `canonical_conversation_tags`
--    sai do settings, `fn_tags_de_conversa_em_uso` e o índice GIN saem. A
--    COLUNA fica, vazia e travada por CHECK: as funções de LGPD
--    (`fn_redigir_conversas_ao_anonimizar` e irmãs) ainda escrevem `tags = '{}'`
--    nela, e reescrever a anonimização para tirar uma coluna sem uso não vale
--    o risco.

-- ── 1 · normalizar: remover tira só a etiqueta pedida ─────────────────────────
create or replace function public.fn_tags_normalizar(
  p_tags text[],
  p_de text,
  p_para text,
  p_remover boolean
)
returns text[]
language sql
immutable
security invoker
set search_path = public
as $$
  select coalesce(array_agg(n.tag order by n.ord), '{}'::text[])
  from (
    select distinct on (lower(s.tag)) s.tag, s.ord
    from (
      select case
               when lower(btrim(e.valor)) = lower(btrim(coalesce(p_de, '')))
                 then case when p_remover then null else btrim(p_para) end
               else btrim(e.valor)
             end as tag,
             e.ord
      from unnest(coalesce(p_tags, '{}'::text[])) with ordinality as e(valor, ord)
      where btrim(coalesce(e.valor, '')) <> ''
    ) s
    where s.tag is not null and s.tag <> ''
    order by lower(s.tag), s.ord
  ) as n;
$$;

-- ── 2 · conversa sem tag ──────────────────────────────────────────────────────
drop function if exists public.fn_tags_de_conversa_em_uso(uuid);
drop index if exists public.idx_conversations_tags_gin;

update public.conversations set tags = '{}'::text[] where tags <> '{}'::text[];

update public.organizations
   set settings = settings - 'canonical_conversation_tags'
 where settings ? 'canonical_conversation_tags';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conversations_sem_tags'
       and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_sem_tags check (tags = '{}'::text[]);
  end if;
end $$;

-- ── 3 · backfill: cada entrada do vocabulário ganha a entidade ────────────────
do $$
declare
  r record;
  e record;
  v_obj jsonb;
  v_chave text;
  v_ents text[];
  v_ent text;
  v_nova jsonb;
begin
  for r in
    select o.id, o.settings -> 'tags' as lista
      from public.organizations o
     where jsonb_typeof(o.settings -> 'tags') = 'array'
  loop
    v_nova := '[]'::jsonb;
    for e in
      select x.valor, x.ord
        from jsonb_array_elements(r.lista) with ordinality as x(valor, ord)
       order by x.ord
    loop
      v_obj := case
        when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', btrim(e.valor #>> '{}'))
        when jsonb_typeof(e.valor) = 'object' then e.valor
        else null
      end;
      continue when v_obj is null or coalesce(btrim(v_obj ->> 'tag'), '') = '';

      if v_obj ->> 'entidade' in ('lead', 'contact') then
        v_ents := array[v_obj ->> 'entidade'];
      else
        v_chave := lower(btrim(v_obj ->> 'tag'));
        v_ents := array[]::text[];
        if exists (
             select 1 from public.contacts c, unnest(coalesce(c.tags, '{}'::text[])) t(valor)
              where c.organization_id = r.id and lower(btrim(t.valor)) = v_chave)
           or exists (
             select 1
               from public.automation_rules ar
               cross join lateral jsonb_array_elements(coalesce(ar.actions, '[]'::jsonb)) a(valor)
               cross join lateral jsonb_array_elements_text(
                 case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                      then a.valor -> 'config' -> 'tags' else '[]'::jsonb end) t(valor)
              where ar.organization_id = r.id
                and a.valor ->> 'type' = 'add_tag'
                and a.valor -> 'config' ->> 'destino' = 'contato'
                and lower(btrim(t.valor)) = v_chave)
        then
          v_ents := v_ents || 'contact'::text;
        end if;
        if exists (
             select 1 from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) t(valor)
              where l.organization_id = r.id and lower(btrim(t.valor)) = v_chave)
           or exists (
             select 1
               from public.automation_rules ar
               cross join lateral jsonb_array_elements(coalesce(ar.actions, '[]'::jsonb)) a(valor)
               cross join lateral jsonb_array_elements_text(
                 case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                      then a.valor -> 'config' -> 'tags' else '[]'::jsonb end) t(valor)
              where ar.organization_id = r.id
                and a.valor ->> 'type' = 'add_tag'
                and coalesce(a.valor -> 'config' ->> 'destino', 'card') <> 'contato'
                and lower(btrim(t.valor)) = v_chave)
           or exists (
             select 1
               from public.followup_flow_versions fv
               cross join lateral jsonb_path_query(fv.graph, 'lax $.**.config.tags[*]') t(valor)
              where fv.organization_id = r.id
                and jsonb_typeof(t.valor) = 'string'
                and lower(btrim(t.valor #>> '{}')) = v_chave)
           or exists (
             select 1
               from public.followup_flow_pointers fp
               cross join lateral jsonb_path_query(coalesce(fp.draft_graph, '{}'::jsonb), 'lax $.**.config.tags[*]') t(valor)
              where fp.organization_id = r.id
                and jsonb_typeof(t.valor) = 'string'
                and lower(btrim(t.valor #>> '{}')) = v_chave)
        then
          v_ents := v_ents || 'lead'::text;
        end if;
        if cardinality(v_ents) = 0 then
          v_ents := array['lead', 'contact'];
        end if;
      end if;

      foreach v_ent in array v_ents loop
        continue when exists (
          select 1 from jsonb_array_elements(v_nova) n(valor)
           where n.valor ->> 'entidade' = v_ent
             and lower(btrim(n.valor ->> 'tag')) = lower(btrim(v_obj ->> 'tag'))
        );
        v_nova := v_nova || jsonb_build_array(v_obj || jsonb_build_object('entidade', v_ent));
      end loop;
    end loop;

    if v_nova is distinct from r.lista then
      update public.organizations
         set settings = jsonb_set(settings, '{tags}', v_nova)
       where id = r.id;
    end if;
  end loop;
end $$;

-- ── 4 · leitura do vocabulário, uma linha por (entidade, tag) ─────────────────
drop function if exists public.fn_vocabulario_de_tags(uuid);
create function public.fn_vocabulario_de_tags(p_org uuid)
returns table (
  tag text,
  entidade text,
  uso bigint,
  em_regras bigint,
  cor text,
  descricao text,
  no_vocabulario boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with vocabulario as (
    select
      nullif(btrim(coalesce(e.valor ->> 'tag', e.valor #>> '{}')), '') as tag,
      case when e.valor ->> 'entidade' in ('lead', 'contact')
           then array[e.valor ->> 'entidade'] else array['lead', 'contact'] end as ents,
      nullif(btrim(coalesce(e.valor ->> 'cor', '')), '') as cor,
      nullif(btrim(coalesce(e.valor ->> 'descricao', '')), '') as descricao,
      e.ord
    from public.organizations o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.settings -> 'tags') = 'array'
           then o.settings -> 'tags' else '[]'::jsonb end
    ) with ordinality as e(valor, ord)
    where o.id = p_org
  ),
  voc as (
    select distinct on (ent.valor, lower(v.tag))
           v.tag, ent.valor as entidade, v.cor, v.descricao
    from vocabulario v
    cross join lateral unnest(v.ents) as ent(valor)
    where v.tag is not null
    order by ent.valor, lower(v.tag), (v.cor is not null or v.descricao is not null) desc, v.ord
  ),
  uso as (
    select nullif(btrim(t.valor), '') as tag, 'contact'::text as entidade
    from public.contacts c, unnest(coalesce(c.tags, '{}'::text[])) as t(valor)
    where c.organization_id = p_org
    union all
    select nullif(btrim(t.valor), ''), 'lead'
    from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) as t(valor)
    where l.organization_id = p_org
  ),
  regras as (
    select r.id as regra_id,
           nullif(btrim(etiqueta.valor #>> '{}'), '') as tag,
           case when acao.valor -> 'config' ->> 'destino' = 'contato' then 'contact' else 'lead' end as entidade
    from public.automation_rules r
    cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) as acao(valor)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(acao.valor -> 'config' -> 'tags') = 'array'
           then acao.valor -> 'config' -> 'tags' else '[]'::jsonb end
    ) as etiqueta(valor)
    where r.organization_id = p_org
      and acao.valor ->> 'type' = 'add_tag'
  ),
  bruto as (
    select v.tag, v.entidade from voc v
    union all select u.tag, u.entidade from uso u where u.tag is not null
    union all select g.tag, g.entidade from regras g where g.tag is not null
  ),
  todas as (
    select min(b.tag) as tag, lower(b.tag) as chave, b.entidade
    from bruto b
    group by lower(b.tag), b.entidade
  )
  select
    coalesce(v.tag, t.tag) as tag,
    t.entidade,
    (select count(*) from uso u where lower(u.tag) = t.chave and u.entidade = t.entidade) as uso,
    (select count(distinct g.regra_id) from regras g
      where lower(g.tag) = t.chave and g.entidade = t.entidade) as em_regras,
    v.cor,
    v.descricao,
    (v.tag is not null) as no_vocabulario
  from todas t
  left join voc v on lower(v.tag) = t.chave and v.entidade = t.entidade
  order by t.entidade, t.chave
  limit 1000;
$$;

revoke execute on function public.fn_vocabulario_de_tags(uuid) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags(uuid) to authenticated, service_role;

-- ── 5 · operar, escopado por entidade ─────────────────────────────────────────
drop function if exists public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text);
drop function if exists public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text, text);
create function public.fn_vocabulario_de_tags_operar(
  p_org uuid,
  p_acao text,
  p_tag text,
  p_destino text,
  p_cor text,
  p_entidade text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tag      text := btrim(coalesce(p_tag, ''));
  v_destino  text := btrim(coalesce(p_destino, ''));
  v_cor      text := lower(btrim(coalesce(p_cor, '')));
  v_ent      text := btrim(coalesce(p_entidade, ''));
  v_registros integer := 0;
  v_regras   integer := 0;
  v_settings jsonb;
  v_lista    jsonb;
  v_nova     jsonb := '[]'::jsonb;
  v_obj      jsonb;
  v_achou    boolean := false;
  e          record;
begin
  -- Portão de papel ANTES de qualquer escrita (definer com p_org da rota).
  if p_org is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;
  if p_acao is null or p_acao not in ('criar', 'renomear', 'juntar', 'excluir', 'definir_cor') then
    raise exception using errcode = '22023', message = 'acao_invalida';
  end if;
  if v_ent not in ('lead', 'contact') then
    raise exception using errcode = '22023', message = 'entidade_invalida';
  end if;
  if v_tag = '' then
    raise exception using errcode = '22023', message = 'tag_obrigatoria';
  end if;
  if p_acao in ('renomear', 'juntar') and v_destino = '' then
    raise exception using errcode = '22023', message = 'destino_obrigatorio';
  end if;
  if v_cor <> '' and v_cor !~ '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'cor_invalida';
  end if;

  select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o where o.id = p_org;
  v_settings := coalesce(v_settings, '{}'::jsonb);
  v_lista := case when jsonb_typeof(v_settings -> 'tags') = 'array'
                  then v_settings -> 'tags' else '[]'::jsonb end;

  -- O vocabulário reescrito: entradas de OUTRA entidade passam intactas; as
  -- desta entidade com o nome pedido recebem a ação. Entrada sem `entidade`
  -- (escrita fora desta função) vale para as duas.
  for e in
    select x.valor, x.ord from jsonb_array_elements(v_lista) with ordinality x(valor, ord) order by x.ord
  loop
    v_obj := case
      when jsonb_typeof(e.valor) = 'string' then jsonb_build_object('tag', btrim(e.valor #>> '{}'))
      when jsonb_typeof(e.valor) = 'object' then e.valor
      else null
    end;
    continue when v_obj is null or coalesce(btrim(v_obj ->> 'tag'), '') = '';

    if coalesce(v_obj ->> 'entidade', v_ent) = v_ent
       and lower(btrim(v_obj ->> 'tag')) = lower(v_tag) then
      v_achou := true;
      v_obj := v_obj || jsonb_build_object('entidade', v_ent);
      if p_acao = 'excluir' then
        continue;
      elsif p_acao in ('renomear', 'juntar') then
        v_obj := v_obj || jsonb_build_object('tag', v_destino);
      elsif p_acao = 'definir_cor' or (p_acao = 'criar' and v_cor <> '') then
        v_obj := case when v_cor = '' then v_obj - 'cor' else v_obj || jsonb_build_object('cor', v_cor) end;
      end if;
    end if;

    -- Uma entrada por (entidade, nome): a que chega depois só empresta a cor.
    if exists (
      select 1 from jsonb_array_elements(v_nova) n(valor)
       where coalesce(n.valor ->> 'entidade', '') = coalesce(v_obj ->> 'entidade', '')
         and lower(btrim(n.valor ->> 'tag')) = lower(btrim(v_obj ->> 'tag'))
    ) then
      if v_obj ? 'cor' then
        select coalesce(jsonb_agg(
                 case when coalesce(n.valor ->> 'entidade', '') = coalesce(v_obj ->> 'entidade', '')
                       and lower(btrim(n.valor ->> 'tag')) = lower(btrim(v_obj ->> 'tag'))
                       and not (n.valor ? 'cor')
                      then n.valor || jsonb_build_object('cor', v_obj -> 'cor')
                      else n.valor end
                 order by n.ord), '[]'::jsonb)
          into v_nova
          from jsonb_array_elements(v_nova) with ordinality n(valor, ord);
      end if;
      continue;
    end if;
    v_nova := v_nova || jsonb_build_array(v_obj);
  end loop;

  if p_acao = 'criar' and v_achou then
    raise exception using errcode = '23505', message = 'tag_ja_existe';
  end if;
  if not v_achou and p_acao in ('criar', 'definir_cor') then
    v_nova := v_nova || jsonb_build_array(
      jsonb_build_object('tag', v_tag, 'entidade', v_ent)
        || case when v_cor = '' then '{}'::jsonb else jsonb_build_object('cor', v_cor) end
    );
  end if;

  -- Os registros e as regras: só renomear/juntar/excluir, só desta entidade.
  if p_acao in ('renomear', 'juntar', 'excluir') then
    if v_ent = 'contact' then
      with alvo as (
        select c.id, public.fn_tags_normalizar(c.tags, v_tag, v_destino, p_acao = 'excluir') as novas
          from public.contacts c
         where c.organization_id = p_org
           and exists (select 1 from unnest(coalesce(c.tags, '{}'::text[])) x(valor)
                        where lower(btrim(x.valor)) = lower(v_tag))
      ), mudou as (
        update public.contacts c set tags = a.novas
          from alvo a where c.id = a.id and c.tags is distinct from a.novas
        returning c.id
      )
      select count(*) into v_registros from mudou;
    else
      with alvo as (
        select l.id, public.fn_tags_normalizar(l.tags, v_tag, v_destino, p_acao = 'excluir') as novas
          from public.crm_leads l
         where l.organization_id = p_org
           and exists (select 1 from unnest(coalesce(l.tags, '{}'::text[])) x(valor)
                        where lower(btrim(x.valor)) = lower(v_tag))
      ), mudou as (
        update public.crm_leads l set tags = a.novas
          from alvo a where l.id = a.id and l.tags is distinct from a.novas
        returning l.id
      )
      select count(*) into v_registros from mudou;
    end if;

    if p_acao = 'excluir' then
      -- A regra NÃO é apagada (decisão de outra tela): só se conta quantas
      -- continuam escrevendo o nome, para a tela avisar.
      select count(distinct r.id) into v_regras
        from public.automation_rules r
        cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) a(valor)
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
               then a.valor -> 'config' -> 'tags' else '[]'::jsonb end) t(valor)
       where r.organization_id = p_org
         and a.valor ->> 'type' = 'add_tag'
         and (case when a.valor -> 'config' ->> 'destino' = 'contato' then 'contact' else 'lead' end) = v_ent
         and lower(btrim(t.valor)) = lower(v_tag);
    else
      with alvo as (
        select r.id,
               jsonb_agg(
                 case
                   when a.valor ->> 'type' = 'add_tag'
                    and jsonb_typeof(a.valor -> 'config' -> 'tags') = 'array'
                    and (case when a.valor -> 'config' ->> 'destino' = 'contato' then 'contact' else 'lead' end) = v_ent
                   then jsonb_set(a.valor, '{config,tags}', to_jsonb(public.fn_tags_normalizar(
                          array(select jsonb_array_elements_text(a.valor -> 'config' -> 'tags')),
                          v_tag, v_destino, false)))
                   else a.valor
                 end
                 order by a.ord
               ) as novas
          from public.automation_rules r
          cross join lateral jsonb_array_elements(coalesce(r.actions, '[]'::jsonb)) with ordinality as a(valor, ord)
         where r.organization_id = p_org
         group by r.id
      ), mudou as (
        update public.automation_rules r
           set actions = alvo.novas, updated_at = now()
          from alvo
         where r.id = alvo.id and r.actions is distinct from alvo.novas
        returning r.id
      )
      select count(*) into v_regras from mudou;
    end if;
  end if;

  if v_nova is distinct from v_lista then
    update public.organizations o
       set settings = jsonb_set(v_settings, '{tags}', v_nova), updated_at = now()
     where o.id = p_org;
  end if;

  return jsonb_build_object(
    'acao', p_acao,
    'entidade', v_ent,
    'tag', v_tag,
    'destino', nullif(v_destino, ''),
    'cor', nullif(v_cor, ''),
    'registros', v_registros,
    'contatos', case when v_ent = 'contact' then v_registros else 0 end,
    'leads', case when v_ent = 'lead' then v_registros else 0 end,
    'regras', v_regras,
    'alterou', (v_nova is distinct from v_lista) or v_registros > 0 or (v_regras > 0 and p_acao <> 'excluir')
  );
end;
$$;

revoke execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text, text) from public, anon;
grant  execute on function public.fn_vocabulario_de_tags_operar(uuid, text, text, text, text, text) to authenticated, service_role;
