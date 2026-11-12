-- manifest: followup_enrollments entra na publicação supabase_realtime para a aba Execuções do editor atualizar ao vivo (o polling de 10 s vira recuperação)
--
-- A aba Execuções (`ExecucoesDoFluxo`) assina `followup_enrollments` filtrada pelo fluxo aberto (`pointer_id`) e só
-- INVALIDA a lista e o dossiê — o evento não carrega dado para a tela, a releitura passa pela API e pela RLS de sempre.
-- Sem a tabela na publicação o canal sobe, responde SUBSCRIBED e nunca entrega nada (ver
-- `tests/unit/realtime-assinatura-tem-publicacao.test.ts`).
--
-- Custo: o motor escreve na linha a cada passo e a cada claim; a tela agrupa os eventos (uma releitura por segundo no
-- máximo) e só existe enquanto alguém está com a aba aberta. Os diários (`followup_execution_steps/attempts`) ficam
-- FORA de propósito: todo passo já move a linha da execução, e publicá-los dobraria o volume sem informação nova.
--
-- Idempotente: só adiciona se ainda não estiver na publicação. Portável em psql puro; sem publicação (Postgres sem
-- Supabase), não faz nada.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'followup_enrollments'
     ) then
    execute 'alter publication supabase_realtime add table public.followup_enrollments';
  end if;
end $$;
