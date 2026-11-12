-- manifest: Reaplica as travas canônicas de suporte após as tabelas recentes para proteger conversation_pins já na instalação fresca
-- A 0662 acrescentou a tabela depois da última aplicação das travas. Uma
-- atualização a protegia na segunda passada, mas a instalação ficava incompleta.
-- O helper inclui somente tabelas graváveis por authenticated; tentativas,
-- passagens e efeitos continuam sem escrita de sessão e sem policies extras.
do $$
begin
  perform public.fn_aplicar_travas_de_suporte();
end;
$$;
