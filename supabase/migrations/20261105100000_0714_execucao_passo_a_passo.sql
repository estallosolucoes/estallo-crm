-- manifest: followup_enrollments ganha passo_a_passo (execução que o operador conduz bloco a bloco): o motor pausa depois de cada bloco concluído e só segue quando alguém manda executar o próximo
--
-- A reexecução manual «bloco por bloco» do editor de fluxos cria uma execução nova que nasce PAUSADA no gatilho. Cada
-- clique em «Executar próximo bloco» a põe de volta no relógio por um bloco; o motor, ao avançar para o bloco seguinte,
-- a pausa de novo (`paused_manual`, o mesmo estado da pausa por pessoa). «Continuar automaticamente» desliga a marca e
-- a execução segue sozinha dali em diante.
--
-- A coluna é só uma marca de COMO conduzir: nasce falsa em toda execução existente e não altera nenhuma delas. Não entra
-- na trava de imutabilidade (`fn_followup_execution_origin_immutable`) de propósito — «continuar automaticamente» a
-- desliga numa execução em andamento.
--
-- Idempotente: repetir não muda nada. Portável em psql puro.

alter table if exists public.followup_enrollments
  add column if not exists passo_a_passo boolean not null default false;

comment on column public.followup_enrollments.passo_a_passo is
  'Execução conduzida bloco a bloco pelo operador: o motor pausa (paused_manual) depois de cada bloco concluído.';
