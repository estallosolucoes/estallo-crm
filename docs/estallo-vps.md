# Estallo CRM: implantação e operação

Fork privado de [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM), sob MIT.
O copyright e a licença originais são preservados em `LICENSE`. O histórico upstream
é mantido pelo remoto `upstream`; `origin` é `WJuniorL/estallo-crm`.

## Topologia

VPS dedicada Locaweb em São Paulo, `177.153.68.124` (Ubuntu 24.04, 2 vCPU,
4 GB de RAM e 4 GB de swap, fuso `America/Sao_Paulo`), acessada por
`root` com a chave `~/.ssh/estallo-crm`. Domínio `crm.estallo.com.br`, servido
pelo Cloudflare. Supabase exclusivo `cbeqboyfmwyjsybszaxy`. O firewall (`ufw`)
libera só 22, 80 e 443.

Docker Swarm de um nó com duas stacks: `traefik` (proxy e certificados, receita
abaixo) e `estallo-crm`. A aplicação participa da rede overlay `NetPratica` e da
rede interna da stack; worker, scheduler, WAHA, Redis efêmero e seu adaptador HTTP
usam apenas a rede interna. Sem Caddy, portas públicas adicionais, serviços de
voz ou build na VPS. O nome `NetPratica` vem da VPS anterior e foi mantido para
que `docker-stack.estallo.yml` rode sem alteração.

**Migração em 15/10/2026.** Até essa data, a stack rodava na VPS multitenant
`178.156.231.35`, que dividia 3,7 GB entre 13 stacks. A migração levou
`runtime.env`, o clone, as três imagens do commit `63541d702a61f51bc9ec29530c0077d1c011b4ce`
e os volumes do WAHA. A sessão voltou a `WORKING` sem novo pareamento. Depois
disso, tudo do CRM foi removido da VPS anterior, inclusive a deploy key no GitHub.

A stack `traefik` fica em `/opt/stacks/traefik/docker-compose.yml`. O Traefik 3.5
não conversa com o Docker 29 (recusa a API 1.24), por isso a versão é 3.6:

```yaml
version: "3.8"
services:
  traefik:
    image: traefik:v3.6.25@sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d
    command:
      - --providers.swarm=true
      - --providers.swarm.exposedbydefault=false
      - --providers.swarm.network=NetPratica
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entryPoint.to=websecure
      - --entrypoints.web.http.redirections.entryPoint.scheme=https
      - --entrypoints.web.http.redirections.entrypoint.permanent=true
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencryptresolver.acme.httpchallenge=true
      - --certificatesresolvers.letsencryptresolver.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencryptresolver.acme.storage=/etc/traefik/letsencrypt/acme.json
      - --certificatesresolvers.letsencryptresolver.acme.email=pratica.biomed@gmail.com
      - --log.level=INFO
    ports:
      - { target: 80, published: 80, mode: host }
      - { target: 443, published: 443, mode: host }
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - certificates:/etc/traefik/letsencrypt
    networks: [NetPratica]
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
    deploy:
      placement: { constraints: [node.role == manager] }
      resources: { limits: { memory: 128M } }
networks:
  NetPratica: { external: true }
volumes:
  certificates:
```

### DNS

Os DNS que a Locaweb entrega por DHCP (`186.202.26.26` e `186.202.27.27`)
perdem de 5% a 12% das consultas, e cada perda custa 5–10s. Medido em
15/10/2026: era a causa de "A requisição não respondeu em 10000ms" ao abrir um
funil, e de rajadas de `EAI_AGAIN`/`fetch failed` nos crons. DNS externo por
UDP/53 é bloqueado na rede; por TLS/853 passa. A receita aplicada no host:

```ini
# /etc/systemd/resolved.conf.d/estallo-dns.conf
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 1.0.0.1#cloudflare-dns.com 8.8.8.8#dns.google 186.202.26.26 186.202.27.27
DNSOverTLS=opportunistic
Cache=yes
DNSStubListenerExtra=172.18.0.1
```

`/etc/docker/daemon.json` com `{"dns": ["172.18.0.1"]}` faz todo container usar
esse resolvedor (o arquivo de upstream do host lista 1.1.1.1 por UDP, que não
responde aqui), e o `docker-stack.estallo.yml` repete o `dns:` nos três serviços
do CRM. O firewall libera só `docker_gwbridge → 172.18.0.1:53` (UDP e TCP). Para
conferir: `docker exec <container do app> getent hosts cbeqboyfmwyjsybszaxy.supabase.co`
e `resolvectl statistics` (acertos de cache).

### Relógio

A rede também bloqueia NTP (UDP/123) para qualquer servidor: o
`systemd-timesyncd` ficava ativo com zero pacotes e o relógio derivava. Isso
importa porque as mensagens enviadas pelo CRM usam o relógio da VPS, e as
recebidas usam o do WhatsApp; com deriva, uma resposta pode cair acima da
mensagem que ela responde. Medido em 17/10/2026: desvio de 1,1 s. NTS não
resolve, porque o pacote de hora dele também vai por UDP/123. A receita
aplicada no host acerta o relógio pelo cabeçalho `Date` de servidores HTTPS,
com certificado verificado e ajuste suave:

```bash
apt-get install -y htpdate
# /etc/default/htpdate
HTP_SERVERS="https://www.apple.com https://www.google.com https://www.microsoft.com"
HTP_OPTIONS="-D -a -c -l"
systemctl disable --now systemd-timesyncd && systemctl enable --now htpdate
```

Para conferir: `htpdate -q https://www.google.com` (desvio atual) e
`journalctl -u htpdate` (ajustes feitos).

Não agendar `docker image prune -a` nesta VPS. As imagens do CRM não existem em
registro, então a limpeza apagaria a versão anterior e o rollback deixaria de funcionar.

As três imagens próprias têm o mesmo SHA completo. O caminho inicial usou
imagens publicadas pelo CI; enquanto a publicação no GHCR não estiver provada
(ver "Deploy pelo GitHub Actions"), é permitido gerar imagens Linux/AMD64 no
computador da Estallo e transferi-las por SSH.
O deploy verifica que todas existem antes de trocar qualquer serviço.
Nenhuma tag móvel é usada na instalação.

Em 13/10/2026, o proprietário autorizou implantar diretamente na VPS após o
esgotamento da cota de Actions. Todos os workflows deste fork foram desativados.
O piloto usa as imagens AMD64 já publicadas do commit
`1692ad9eb367b8cb9bfc39b79c0ca84cf9abc87a`, com sufixo `-amd64`. Não houve build
na VPS. Até aquele deploy, as alterações posteriores a esse commit só alcançavam
operação, testes e documentação; o código em execução correspondia às imagens.
O mapeamento de tags fica protegido em `/opt/stacks/estallo-crm/image-tags.json`
e acompanha os backups. Ele também é usado ao retornar a uma versão anterior.

```bash
python3 scripts/estallo-vps.py deploy --sha 1692ad9eb367b8cb9bfc39b79c0ca84cf9abc87a --image-tag 1692ad9eb367b8cb9bfc39b79c0ca84cf9abc87a-amd64
```

## Deploy pelo GitHub Actions (caminho de destino)

> **Migrations não vão pelo `entregar.sh` nem pela ação `deploy`.** Só o fluxo `agent` chama `migrate(previous,target)`, que recusa migration já aplicada que apareça como modificada (`M`). Quem entrega imagem local aplica as migrations novas à mão (`psql --single-transaction -v ON_ERROR_STOP=1`) e nunca edita uma já aplicada. Medido em 05/11/2026 (0712–0714 aplicadas assim, com autorização).

**Estado medido em 05/11/2026:** a cobrança foi regularizada e o GitHub voltou a
executar jobs (o `vigia-de-colisao` de 05/11 rodou os 8 passos; os runs de
31/10 tinham sido recusados com zero passos). O que ainda falta para este
caminho valer:

1. **`publish-image.yml` não rodou desde a regularização.** Ele só publica em
   push na `main`; o último run é de 31/10, recusado pela cobrança. A primeira
   publicação de verdade é a prova de que o caminho funciona.
2. **Os pacotes do GHCR continuam privados** (pedido anônimo de
   `ghcr.io/wjuniorl/estallo-crm{,-worker,-scheduler}` devolve 403), mas
   **a VPS já tem `docker login ghcr.io`** — confirmado pelo proprietário em
   05/11/2026, com deploys anteriores feitos pelo registro. Se o pull falhar com
   `unauthorized`, o token de leitura expirou: refazer o login com um token só de
   `read:packages` (nunca um token com escrita).

Para conferir sem confiar neste parágrafo:

```bash
gh run list -R WJuniorL/estallo-crm -w publish-image.yml --limit 3
gh run list -R WJuniorL/estallo-crm --limit 5   # jobs executando = cobrança ok
```

Quando os dois itens estiverem resolvidos: PR → merge na `main` →
`publish-image.yml` publica as três imagens no GHCR com o SHA completo. Na VPS,
aplicar as migrations novas e implantar pelo registro:

```bash
python3 scripts/estallo-vps.py deploy --sha COMMIT_COMPLETO
python3 scripts/estallo-vps.py verify
```

`deploy` não aplica migrations (só o fluxo `agent` aplica).

## Deploy direto, sem GitHub Actions (caminho em uso)

Em uso desde 13/10/2026, até a primeira publicação pelo GHCR ser provada (ver
a seção anterior). Para uma revisão nova, construir as três imagens pelos Dockerfiles do projeto
em um Docker Linux externo à VPS. Usar o SHA completo em
`APP_VERSION`, na tag e no label OCI `org.opencontainers.image.revision`;
o label de origem dos Dockerfiles deve ser preservado. Nenhuma credencial
operacional entra no build. O build local Windows do Next serve como verificação,
mas o artefato implantado é gerado novamente para Linux pelo Dockerfile.

Transferir o código por um bundle Git e as imagens por um arquivo produzido
com `docker save`, para `/opt/stacks/estallo-crm/images/`. Conferir o SHA-256
do arquivo nos dois lados antes de `docker load`, e manter os artefatos de ambas
as versões para rollback. Depois de colocar o clone na revisão exata, executar:

```bash
python3 scripts/estallo-vps.py deploy --sha COMMIT_COMPLETO --local-images
python3 scripts/estallo-vps.py verify
```

Esse modo recusa Swarm com mais de um nó, arquitetura diferente de Linux/AMD64,
label de outra revisão e substituição de uma imagem já registrada. Os IDs das
três imagens ficam no arquivo protegido `local-images.json`, incluído nos backups.
O Swarm usa as imagens já carregadas, sem consultar tags inexistentes no registro.
Backup prévio (reaproveitado se houver um completo das últimas 24 h), verificações de saúde, margem de memória e rollback automático
continuam ativos. Somente app, worker e scheduler recebem imagens novas;
WAHA, Redis, rede e volumes mantêm suas configurações. O deploy e o rollback
preservam os digests instalados dessas dependências, para não recriá-las pela
retirada de um digest ou pela resolução de uma tag móvel.

Uma versão transferida manualmente não é oferecida pelo atualizador automático,
que continua exigindo imagens publicadas no registro. Para restaurar em outra VPS,
recuperar também os arquivos de imagens guardados no computador da Estallo,
carregá-los com `docker load` e recuperar `local-images.json` antes do deploy.

## Instalação

**Estado publicado em 15/10/2026:** produção na VPS dedicada com imagens Linux/AMD64
do commit `63541d702a61f51bc9ec29530c0077d1c011b4ce`. A versão em execução não
envelhece nesta linha: `cat /opt/stacks/estallo-crm/deployment.json` ou
`curl -s https://crm.estallo.com.br/api/v1/health` (campo `version`).
A identidade e a navegação Estallo entraram em produção em 14/10/2026, com o
commit `8563e3b720c8c34a07f4360f51f1023897885312`. As imagens são construídas
no Docker local e transferidas por SSH, sem Actions.
Prova de HTTPS, login autenticado, temas, planos e navegação está em
[`evidence/estallo-deploy-2026-10-14/README.md`](../evidence/estallo-deploy-2026-10-14/README.md).

O primeiro rollout manual recriou o WAHA por normalização da especificação Swarm
(defaults, ordem dos mounts e metadados de plataforma). O digest e os volumes
foram preservados, e a sessão voltou a `WORKING` sem novo pareamento. Na VPS
anterior, que era compartilhada, os containers dos demais projetos permaneceram
os mesmos. Preservar digests impede troca da versão, mas não garante que o
Swarm nunca recrie uma dependência ao normalizar sua especificação.

1. Preparar o host: instalar o Docker, rodar `docker swarm init`, criar a rede com
   `docker network create -d overlay --attachable NetPratica` e subir a stack `traefik`
   com `docker stack deploy -c /opt/stacks/traefik/docker-compose.yml traefik`.
2. Apontar o registro A de `crm.estallo.com.br` para o IP da VPS.
3. Clonar o repositório por deploy key read-only em `/opt/stacks/estallo-crm/repo`.
   O clone usa `core.sshCommand = ssh -i /root/.ssh/estallo_crm_deploy_key -o IdentitiesOnly=yes`.
4. Guardar as credenciais em `/opt/stacks/estallo-crm/credentials.env`, com modo 600:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `OWNER_EMAIL`, `OWNER_PASSWORD`.
   A conexão Postgres deve ser o Session pooler com senha e usuário do projeto.
5. Na raiz do clone, executar:

```bash
python3 scripts/estallo-vps.py configure --credentials /opt/stacks/estallo-crm/credentials.env
python3 scripts/estallo-vps.py bootstrap --sha COMMIT_COMPLETO
python3 scripts/estallo-vps.py deploy --sha COMMIT_COMPLETO
```

O configure gera as chaves internas e grava `runtime.env` fora do clone.
Bootstrap recusa bancos alheios, retoma somente um baseline confirmado neste host,
habilita extensões, aplica
o baseline e cria o administrador. Nenhuma credencial entra nas imagens.

No Supabase, configurar Site URL `https://crm.estallo.com.br` e Redirect URL
`https://crm.estallo.com.br/auth/confirm`. Configurar os modelos de e-mail com
Estallo CRM. O token de gerenciamento do Supabase, se disponibilizado, permite
automatizar essa configuração; as chaves da API sozinhas não concedem essa permissão.
Envio operacional completo requer SMTP ou Resend com remetente verificado.

## Atualização, rollback e backup

O agente do host consulta somente `origin/main` e oferece atualização quando
as três imagens daquele commit estão publicadas. O clique na tela existente
é lido pelo agente; progresso e resultado voltam a `/api/v1/system/agent`.
Atualizações aplicam somente migrations novas; edição de migration antiga é recusada.

**Pendência desde a migração de 15/10/2026:** a VPS atual ainda não tem deploy key
do GitHub. Sem ela, `git fetch` e o comando `agent` falham. O deploy manual com
`--local-images` não depende dela. Para resolver, gerar `/root/.ssh/estallo_crm_deploy_key`
na VPS e cadastrar a parte pública como deploy key **read-only** do repositório.

```bash
python3 scripts/estallo-vps.py agent
python3 scripts/estallo-vps.py backup
python3 scripts/estallo-vps.py rollback
python3 scripts/estallo-vps.py verify
```

Agendar no host, após o primeiro deploy validado:

```cron
*/5 * * * * cd /opt/stacks/estallo-crm/repo && python3 scripts/estallo-vps.py agent >> /opt/stacks/estallo-crm/agent.log 2>&1
0 3 * * * cd /opt/stacks/estallo-crm/repo && python3 scripts/estallo-vps.py backup >> /opt/stacks/estallo-crm/backup.log 2>&1
```

O horário do cron é o do host, atualmente `America/Sao_Paulo`, com o mesmo
deslocamento de `America/Bahia`. O backup local foi agendado às 03:00.
Backups contêm banco, configuração, objetos do Supabase Storage e volumes de sessões/mídia do WAHA. O dump
é validado por `pg_restore --list`. Para cópia externa, configurar
`BACKUP_SSH_TARGET=usuario@servidor:/diretorio` no arquivo protegido, com SSH por chave.
Sem destino externo, o script declara a pendência; backup na mesma VPS não é cópia externa.
Cada backup novo apaga os locais mais velhos que os 5 completos mais recentes (`BACKUPS_KEPT`):
sem isso, a pasta encheu os 67 GB da VPS em 11/11/2026. O `deploy` não faz backup novo quando
já existe um completo das últimas 24 h (`BACKUP_REUSE_HOURS`), porque ele só troca imagens e
não aplica migrations; o fluxo `agent`, que aplica, continua fazendo backup antes.

No piloto, o computador do proprietário faz a cópia externa pela tarefa Windows
`Estallo CRM - Backup externo`, às 03:20 e ao entrar no Windows. Ela executa uma
cópia protegida de `scripts/estallo-backup-pull.ps1`, em
`C:\Users\junio\.estallo-crm\pull-backups.ps1` (acessa a VPS com a chave
`~/.ssh/estallo-crm`; ao alterar o script no repositório, copiar de novo para
esse caminho), e guarda os backups em
`C:\Users\junio\OneDrive\Documentos\backup-estallo-crm`. O log fica em
`C:\Users\junio\.estallo-crm\backup-external.log`; arquivos incompletos são
tentados novamente, e cada cópia concluída recebe um recibo. A cópia depende
do computador ligado, conectado e com acesso SSH; um destino permanente
continua sendo uma melhoria operacional recomendada.

Restauração exige parar somente a stack Estallo e usar banco vazio compatível:
restaurar o dump por `pg_restore --no-owner`, preservando os grants e revokes, recuperar `runtime.env`
e os volumes pelos arquivos `.tgz`, e implantar o SHA registrado em `deployment.json`.
Recuperar também `image-tags.json`, com permissões 600, quando
presentes no snapshot; isso preserva o artefato AMD64 e o acesso administrativo.
Recuperar os objetos de `storage/` usando o bucket, nome e tipo registrados em
`storage/manifest.json`, pela API de upload do Supabase com `x-upsert: true`.
O dump guarda metadados, e os arquivos dessa pasta guardam os bytes dos anexos.
Validar essa recuperação em ambiente separado antes de confiar nela.
Rollback volta as três imagens juntas; não desfaz schema nem apaga volumes.

## Aceite e continuidade

O login local foi conferido em desktop (`evidence/estallo-crm/login-desktop.png`)
e celular (`evidence/estallo-crm/login-mobile.png`). Essas capturas comprovam
a marca no ambiente local; o aceite da instalação na VPS continua separado.
O login real do administrador chegou às boas-vindas
(`evidence/estallo-crm/onboarding-welcome.png`), com a marca e o símbolo E.
A implantação foi conferida por HTTPS em desktop
(`evidence/estallo-crm/login-vps-desktop.png`) e celular
(`evidence/estallo-crm/login-vps-mobile.png`). O administrador entrou na VPS
(`evidence/estallo-crm/onboarding-vps.png`), e a recuperação aceitou o pedido
(`evidence/estallo-crm/recovery-vps.png`); recebimento e redefinição por e-mail
ainda dependem da confirmação do proprietário.

Verificar login, recuperação, onboarding, nomes e ícone do produto pela tela. Parear um
WhatsApp e comprovar mensagem recebida/enviada. Sem chave de IA, cadastrar em
IA → Credenciais antes de testar agente e handoff. Telemetria fica desligada.

O piloto exige pelo menos 1 GB disponível antes do deploy e mantém margem de
512 MB durante a conferência. Falha no primeiro deploy escala somente seus seis
serviços para zero, preservando volumes; em atualização, tenta voltar o conjunto anterior.
O resultado não é sucesso se HTTPS, `/app`, saúde ou memória falharem.

Living System Checklist: o commit e a configuração alimentam a stack; ela
alimenta aplicação, worker e scheduler. Os recibos de atualização existentes
aparecem na tela de atualização; falhas ficam no log do host e no run da tela.
O cron do agente é o próximo passo para pedido pendente. Marca é fixa na plataforma,
com política visível em `/admin/marca`. A continuidade IA/humano existente permanece
no worker e no inbox; esta mudança é infraestrutura. Falha de rollout impede
o commit novo de virar estado instalado e aciona recuperação do conjunto anterior.

O arquivo de credenciais do administrador fica fora da cópia externa automática.
Em uma VPS nova, recupere-o pelo arquivo protegido do administrador solicitado
ao instalar, sem enviar a senha pelo chat ou adicioná-la ao Git.
