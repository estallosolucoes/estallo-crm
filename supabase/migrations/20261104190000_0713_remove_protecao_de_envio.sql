-- manifest: Remove a Proteção de envio do banco: tabelas pacing_ledger, channel_session_warmup e outbound_copies, as duas funções de poda delas, as colunas de ritmo/janela/aquecimento/spinning de channel_knobs e before_send_traces.tipo_envio (o disjuntor de saúde fica)
--
-- A "Proteção de envio" (ritmo, janela, aquecimento, teto diário e spinning por canal) foi removida do produto:
-- o ritmo entre envios é fixo (300-800 ms, em memória, no código) e nada mais lê estas tabelas e colunas.
-- O disjuntor de saúde do canal FICA: channel_session_health e channel_knobs.health_knobs não são tocados.
--
-- 1. Tabelas sem leitor nem escritor (drop cascata leva índices, policies, grants e FKs próprios).
drop table if exists public.pacing_ledger cascade;
drop table if exists public.channel_session_warmup cascade;
drop table if exists public.outbound_copies cascade;

-- 2. As podas dessas tabelas.
drop function if exists public.fn_expurgar_ritmo_de_envio_vencido(int, int);
drop function if exists public.fn_expurgar_copias_enviadas_vencidas(int, int);

-- 3. Colunas de channel_knobs que eram só da Proteção de envio. A tabela fica (health_knobs). O fuso vem de
--    organizations.timezone; nenhum código lê channel_knobs.timezone.
alter table if exists public.channel_knobs
  drop constraint if exists channel_knobs_warmup_caps_is_array,
  drop constraint if exists channel_knobs_spinning_is_object,
  drop constraint if exists channel_knobs_resposta_horas_validas,
  drop constraint if exists channel_knobs_atraso_humano_saneamento,
  drop constraint if exists channel_knobs_prospeccao_dias_validos;
alter table if exists public.channel_knobs
  drop column if exists throttle_ms,
  drop column if exists jitter_max_ms,
  drop column if exists window_start_hour,
  drop column if exists window_end_hour,
  drop column if exists allow_sunday,
  drop column if exists timezone,
  drop column if exists warmup_daily_caps,
  drop column if exists spinning_knobs,
  drop column if exists number_activated_at,
  drop column if exists resposta_start_hour,
  drop column if exists resposta_end_hour,
  drop column if exists atraso_notar_ms,
  drop column if exists ms_por_caractere,
  drop column if exists atraso_minimo_ms,
  drop column if exists atraso_maximo_ms,
  drop column if exists prospeccao_dias;

-- 4. O trace de envio vetado deixou de dizer se era resposta ou disparo: a janela por tipo de envio não existe mais.
alter table if exists public.before_send_traces
  drop constraint if exists before_send_traces_tipo_envio_check,
  drop column if exists tipo_envio;

-- Fica: channel_sessions.daily_message_limit / warmup_started_at / warmup_completed_at / is_warmup_complete. Ainda são lidas
-- pelo webhook do WAHA, pela API de canais e por um trigger de channel_sessions; sairão num PR próprio.
