-- manifest: Conta as reentradas seguidas, sem job novo ligado, da tentativa em voo de uma classificacao por IA, para que um worker que morre sempre no mesmo ponto pare de reentrar e caia no orcamento de tentativas
-- Dentro da janela de reaproveitamento (max(24 h, 2x carencia)) o `begin` reabre a mesma tentativa
-- sem contar nada; o unico teto era o relogio. Com o contador, passado o limite o `begin` deixa de
-- reaproveitar e segue o caminho de "lease interrompido", que fecha a tentativa e conta no orcamento.
-- Ligar um job NOVO a tentativa (resposta do contato que reenfileira a classificacao) zera o contador:
-- so a reentrada que nunca chega a enfileirar acumula.
-- Coluna nova, com default: tentativas existentes comecam em zero. Nao habilita o contrato novo.
alter table public.followup_execution_attempts
  add column if not exists reuse_count integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.followup_execution_attempts'::regclass and conname='followup_execution_attempts_reuse_count_check') then
    alter table public.followup_execution_attempts add constraint followup_execution_attempts_reuse_count_check
      check (reuse_count >= 0);
  end if;
end;
$$;
