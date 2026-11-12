# Conferência do Estallo CRM — 13/10/2026

## Medido

- Código e histórico importados de `upstream/main` (`0c05ca348`); a pasta original
  não tinha alterações de código, somente o documento da VPS acrescentado.
- Repositório privado e PR: https://github.com/estallosolucoes/estallo-crm/pull/1.
- Supabase exclusivo: baseline aplicado; consulta ao banco retornou 187 tabelas
  públicas e 187 com RLS habilitada. Isso verifica a ativação, não substitui os
  testes de isolamento entre organizações.
- Login local em 1440×1000 e 390×844: título `Entrar · Estallo CRM`, nome próprio
  visível e um único botão com o rótulo exato `Entrar`. Capturas nesta pasta.
- Typecheck passou com Node 22 e heap de 6 GB. Lint: zero erros; avisos herdados.
- Gates de canal e papel passaram; 54 casos de marca e 85 casos das correções de
  distribuição/CI passaram. Os 15 casos do operador são testes com dublês:
  **não são um ensaio de rollback na VPS**.
- O job `Estallo VPS` verificou a receita pelo `docker stack config` no Linux.
- DNS de `crm.estallo.com.br` resolve via Cloudflare. O registro foi criado pelo
  usuário; nenhuma configuração Cloudflare foi alterada pelo agente.
- A nova Secret Key passou na API administrativa (HTTP 200). O administrador
  inicial foi criado e entrou pela tela até `/onboarding/welcome`, em ambiente
  local, com nome Estallo CRM e inicial E. Os buckets do baseline existem;
  `whatsapp-media` é privado. Site URL e Redirect URL foram confirmados pelo usuário.
- Primeiro backup validado e copiado para `OneDrive/Documentos/backup-estallo-crm`.
  Backup local diário agendado às 03:00. A tarefa Windows faz a cópia externa
  às 03:20 e ao entrar no computador; a execução manual copiou o snapshot.
  Essa cópia depende do computador ligado e conectado.
- Os 11 testes da telemetria passaram. O fork desliga coleta por padrão e
  não registra argumentos das ações de servidor no desenvolvimento.
- Isolamento medido no Supabase real: dois usuários temporários só leram
  contatos da própria organização e não alteraram contatos da outra. Os
  usuários e organizações temporários foram removidos ao final.
- O CI Linux passou no kit shell completo. Restaram expectativas de nome
  upstream em testes unitários, corrigidas e verificadas localmente.
- As imagens AMD64 e ARM64 foram construídas e enviadas pelo CI. O job que
  reúne os manifestos não iniciou: o GitHub informou bloqueio por cobrança
  ou limite de gastos da organização. A publicação completa está pendente.
- O proprietário autorizou o deploy direto em 13/10/2026. Os workflows foram
  desativados. A stack foi implantada com as três imagens AMD64 já publicadas
  de `1692ad9eb367b8cb9bfc39b79c0ca84cf9abc87a`; não houve build na VPS.
- Os seis serviços estão ativos, com limites de recursos e sem OOM observado.
  HTTPS, página inicial 200, `/app` 307 e saúde de Supabase, Redis e WAHA
  foram conferidos. Os 21 endereços preexistentes mantiveram as respostas.
- Login do administrador e boas-vindas conferidos na VPS, além de login mobile.
  Recuperação aceitou o pedido de envio e o usuário confirmou o recebimento do
  e-mail de Supabase Auth. A redefinição da senha ainda precisa de confirmação.
  WhatsApp pareado pelo usuário; a consulta da sessão retornou `WORKING`.
  O usuário confirmou recebimento e resposta pela tela, nos dois sentidos.
- Backup após o deploy validado e copiado para o computador. O operador aceita
  somente tags do mesmo commit, incluindo o artefato AMD64; 17 testes passaram.

## Ainda não medido/concluído

- Conjunto final completo de CI, interrompido pela cota de Actions. Os testes
  relevantes das correções foram executados localmente; isso não é o CI completo.
- Redefinição por e-mail e conclusão do onboarding.
  O remetente ainda é o padrão do Supabase; SMTP próprio não foi fornecido.
- Rollback entre versões diferentes, restauração de backup e execução diária
  da cópia externa. O ensaio Swarm usa a mesma versão; uma oscilação após o
  reinício foi seguida por oito sondas com dependências saudáveis e memória
  disponível acima de 1 GB, seguidas por seis verificações finais aprovadas pelo
  operador. As configurações e os volumes foram preservados.
- Atendimento por IA: nenhuma credencial de provedor foi fornecida.

A chave administrativa inicialmente tinha a role `anon`, recusada pelo operador.
O usuário forneceu uma Secret Key válida depois. Credenciais permanecem fora do
Git. A senha inicial foi substituída após aparecer num diagnóstico do Next em
desenvolvimento; a senha atual está no arquivo solicitado pelo usuário.

Os testes shell no Windows encontraram limitações de permissões POSIX e do
executável `python3`; a validação completa do kit deve ser lida no CI Linux.
As correções do fork incluem as expectativas de nomes de imagens e diretórios
dos dublês, permissões de leitura do PR privado e memória de compilação.
