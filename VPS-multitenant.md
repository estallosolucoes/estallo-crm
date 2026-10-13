# VPS Multi-tenant — Padrão de Infraestrutura

**VPS:** 178.156.231.35 (Docker Swarm, single-node) · **Atualizado:** 08/07/2026

Este arquivo descreve o padrão para hospedar **múltiplas empresas e projetos**
na mesma VPS. Copie-o para a raiz de todo novo repositório que for subir aqui
e ajuste nomes/domínios. Ele acompanha o `CLAUDE.md` de cada projeto, que traz
os comandos de deploy específicos daquele projeto.

⚠️ Esta VPS é compartilhada entre negócios diferentes. Quem colabora em só um
projeto não deve ter a chave root — ver "Acesso de colaboradores".

---

## Princípio geral: 1 stack por projeto (ou por empresa pequena)

**Cada projeto de porte próprio tem sua própria stack Swarm e seu próprio
repositório Git.** Uma empresa com vários sites pequenos e estáticos pode
agrupá-los numa única stack "da empresa".

Stacks de negócio hoje:

| Stack | Repositório | Conteúdo |
|---|---|---|
| `estallo` | `estallosolucoes/estallo` | sites estáticos da Estallo (institucional, blog, propostas, demonstrações, briefing) |
| `estallo-chat` | `estallosolucoes/estallo-chat` | projeto Estallo Chat (Next.js) |
| `catalogo` | `estallosolucoes/catalogo-inteligente` | Catálogo Inteligente (FastAPI) |
| `praticabiomed` | `WJuniorL/praticabiomed` (GitHub **pessoal** — exceção; o repo tem doc própria de deploy) | sites e serviços da Prática Biomed |

Stacks de **infraestrutura compartilhada** (não mexer ao subir projetos;
nunca duplicar por projeto): `traefik`, `portainer`, `postgres`, `pgvector`,
`n8n`, `evolution`, `uptime-kuma`.

## GitHub

- **Organização padrão: `github.com/estallosolucoes`** — todo projeto do
  ecossistema Estallo nasce como repositório (privado) da organização.
  Exceção: Prática Biomed fica no GitHub pessoal (`WJuniorL`).
- Membros da organização têm permissão base "Write" em todos os repos —
  adicionar alguém em People → Invite member já dá acesso a tudo.
- **A VPS acessa cada repo por uma deploy key própria (read-only)** — ver
  seção "Autenticação da VPS com o GitHub".

## Estrutura na VPS

```
/opt/stacks/{projeto}/
├── repo/                ← clone do repositório (via deploy key)
├── {service}.env        ← env por serviço dinâmico, fora do git
├── stack.env            ← variáveis usadas no `docker stack deploy` (se houver)
└── token.json etc.      ← credenciais montadas read-only no container, fora do git
```

O `docker-compose.yml` fica **na raiz do repo** e define a stack inteira do
projeto. Não deixe cópias de compose fora do repo (já causou ambiguidade;
a cópia solta da praticabiomed foi removida em 08/07/2026).

## Recursos compartilhados (nunca duplicar)

- **Traefik** (stack `traefik`, v3) — único reverse proxy; roteia por domínio.
  Labels por serviço: `Host(...)`, `entrypoints=websecure`,
  `tls.certresolver=letsencryptresolver`.
- **Rede overlay `NetPratica`** — todo serviço entra nela (`external: true`
  no compose); é como o Traefik enxerga qualquer stack.
- **Postgres / pgvector / n8n / evolution** — instâncias únicas compartilhadas.
- **Login no `ghcr.io`** — é um só pra máquina toda; ver seção abaixo.

## Registry de imagens (ghcr) — credencial única na máquina

O Docker guarda **uma credencial por registry** em `~/.docker/config.json`. Não
existe "um login por projeto": existe *o* login do `ghcr.io` da VPS inteira, e
um `docker login ghcr.io` novo **sobrescreve** o anterior sem avisar.

> **Regra:** todo pacote no ghcr consumido por essa VPS precisa ser legível pela
> **mesma conta** (hoje `WJuniorL`). Projeto novo publicando num lugar que essa
> conta não lê? Ou dá acesso a ela, ou o deploy de todos os outros quebra quando
> alguém trocar o login pra resolver o próprio caso.

Isso morde nos dois sentidos e é difícil de diagnosticar, porque cada lado
funciona isoladamente — quem trocou resolve o seu projeto e derruba o do vizinho
sem perceber (06/08/2026, Prática Biomed × Estallo).

Ver com qual conta a VPS está logada, sem expor o token:

```bash
python3 -c "import json,base64;d=json.load(open('/root/.docker/config.json'));\
a=d['auths']['ghcr.io']['auth'];print(base64.b64decode(a).decode().split(':')[0])"
```

Um **token classic** pessoal com escopo `read:packages` serve pra tudo que a
conta enxerga, inclusive pacotes de organização. Se falhar só na org, o escopo
não é o problema — são estes dois:

1. **Acesso ao pacote.** No ghcr a permissão é do *pacote*, não herdada do repo:
   `github.com/orgs/<org>/packages` → pacote → *Package settings* → *Manage access*.
2. **SAML SSO.** Token classic precisa ser autorizado explicitamente pra org, em
   `github.com/settings/tokens` → *Configure SSO* ao lado do token. Falha silenciosa.

## Build de imagem: nunca na VPS

A VPS é compartilhada por todas as empresas (~30 containers), com **3,8 GB de RAM
e zero swap**. Build de aplicação ali não fica contido no seu projeto: um
`next build` levou o load average a **48**, fez n8n, Postgres e os serviços da
Estallo pararem de responder — e ainda falhou sem gerar imagem (05/08/2026).

Build é no CI (GitHub Actions), publica no ghcr, e a VPS só faz `docker pull`.
`pull` é rede, não CPU — não incomoda ninguém.

## Pegadinhas conhecidas (Traefik + Cloudflare + Swarm)

Descobertas na migração de domínio da Prática Biomed (20/07/2026):

- **`docker service update --label-add` vs `--container-label-add`.** O
  Traefik lê labels de onde elas realmente estão no container em execução —
  e isso depende de como o serviço foi escrito no compose:
  - Labels em `services.<nome>.labels:` (fora de `deploy:`) só existem no
    **container**. Pra editar via CLI sem reaplicar o compose, use
    `docker service update --container-label-add ...` — `--label-add`
    (sem `container-`) mexe no **serviço** e não tem efeito nenhum aqui,
    mesmo reportando "converged" com sucesso.
  - Labels em `deploy.labels:` ficam no **serviço** (`Spec.Labels`) e
    aparecem no container também — `--label-add` funciona normalmente.
  - Na dúvida, confira onde as labels que já funcionam pro mesmo serviço
    estão (`docker inspect <container> --format '{{json .Config.Labels}}'`
    vs `docker service inspect <service> --format '{{json .Spec.Labels}}'`)
    antes de editar.

- **Prioridade de router quando dois hosts respondem no mesmo domínio.**
  O Traefik usa o tamanho da regra como prioridade por padrão. Uma regra
  com `Host(a) || Host(b)` fica mais comprida que `Host(a) && PathPrefix(x)`
  e pode "roubar" a prioridade de uma rota mais específica no mesmo host
  (ex: um catch-all de site institucional capturando `/checkout` antes do
  router do checkout responder). Sempre que dois routers puderem casar a
  mesma requisição, defina `traefik.http.routers.<nome>.priority=<N>`
  explícito nos dois — não confie na ordem implícita.

- **`image: ...:latest` no Swarm faz o deploy mentir.** O `docker stack deploy`
  decide se reinicia comparando o **spec** do serviço com o aplicado. Com tag
  fixa o spec fica byte-a-byte idêntico entre deploys: a tag aponta pra imagem
  nova, o Swarm conclui "nada mudou" e mantém o container velho de pé. O deploy
  termina com sucesso servindo código antigo, e não há erro em lugar nenhum —
  o sintoma é "publiquei e não mudou". Use **tag imutável por commit**
  (`image: repo/app:${TAG}` com `TAG=$(git rev-parse HEAD)`); o spec passa a
  mudar sempre, o rollout é garantido, e dá rollback apontando pra um SHA
  antigo. (05/08/2026, checkout da Prática Biomed.)

- **Cloudflare Universal SSL (grátis) não cobre wildcard de 2 níveis.**
  Cobre `dominio.com` e `*.dominio.com`, mas **não** `*.sub.dominio.com`
  (ex: `n8n.apps.dominio.com` falha no handshake TLS na borda do Cloudflare,
  sem nem chegar na VPS). Opções: (a) deixar esses hosts específicos em
  "DNS only" — Traefik emite o próprio certificado Let's Encrypt
  normalmente, ou (b) contratar "Total TLS" no Cloudflare, ou (c) usar
  hostname de 1 nível só (`n8n-apps.dominio.com`).

## Nomenclatura

O Swarm prefixa serviço com o nome da stack: `<stack>_<service>`. Com stack
por projeto, use nomes de serviço curtos (`app`, `checkout`, `links`) —
viram `catalogo_app`, `praticabiomed_checkout`. Routers/middlewares Traefik
precisam de nome único na VPS inteira: prefixe com o projeto
(`catalogo`, `catalogo-ratelimit`, `estallo-blog`).

## Criando um projeto novo (checklist)

1. Repositório novo na org `estallosolucoes` (privado).
2. `docker-compose.yml` na raiz: rede `NetPratica` external, labels Traefik,
   e **`deploy.resources.limits` (cpus/memory) obrigatórios** — sem limites,
   um projeto pode consumir os recursos dos outros.
3. DNS: registro A do subdomínio → 178.156.231.35.
4. Deploy key (seção abaixo) + clone em `/opt/stacks/{projeto}/repo`.
5. `docker stack deploy -c /opt/stacks/{projeto}/repo/docker-compose.yml {projeto}`.

## Autenticação da VPS com o GitHub (deploy keys)

A VPS nunca guarda token pessoal; cada repo tem uma **deploy key read-only**
com um alias SSH próprio. Para um projeto novo:

```bash
# 1. na VPS: gerar chave e alias
ssh-keygen -t ed25519 -N '' -f ~/.ssh/{projeto}_deploy_key -C 'deploy@{projeto}'
cat >> ~/.ssh/config <<EOF
Host github-{projeto}
  HostName github.com
  User git
  IdentityFile ~/.ssh/{projeto}_deploy_key
  IdentitiesOnly yes
EOF

# 2. no GitHub: repo → Settings → Deploy keys → Add key (read-only)
#    colar o conteúdo de ~/.ssh/{projeto}_deploy_key.pub

# 3. na VPS: clonar usando o alias
git clone git@github-{projeto}:estallosolucoes/{repo}.git /opt/stacks/{projeto}/repo
```

Aliases já configurados: `github-estallo`, `github-catalogo`,
`github-estallo-chat`.

## Padrão de deploy

1. Atualizar código (sempre):
   ```
   ssh root@178.156.231.35 "cd /opt/stacks/{projeto}/repo && git pull"
   ```
2. Serviços **estáticos** (nginx servindo arquivos por volume): o `git pull`
   já basta. Serviços com **processo de vida longa** (Node, Python):
   ```
   ssh root@178.156.231.35 "docker service update --force {stack}_{service}"
   ```
3. Serviços com **imagem própria** (Dockerfile no repo) — rebuild + update
   forçado do serviço:
   ```
   ssh root@178.156.231.35 "cd /opt/stacks/{projeto}/repo && docker build -t {imagem}:latest . && docker service update --force --image {imagem}:latest {stack}_{service}"
   ```
   ⚠️ `docker stack deploy` sozinho **não troca o container** quando a tag
   (`latest`) é a mesma — sem registry o Swarm não compara digest da imagem.
   O `service update --force` é obrigatório após rebuild.
4. Mudou o `docker-compose.yml` ou variáveis — reaplicar a stack:
   ```
   ssh root@178.156.231.35 "cd /opt/stacks/{projeto}/repo && docker stack deploy -c docker-compose.yml {projeto}"
   ```
   Se o compose interpola variáveis (`${VAR}`), carregue antes o `stack.env`:
   `. /opt/stacks/{projeto}/stack.env && VAR=$VAR docker stack deploy ...`
   (o `docker stack deploy` **não** lê `.env` sozinho).

## Acesso de colaboradores externos

Nunca compartilhe a chave SSH root — ela dá acesso a todos os negócios da
VPS. Crie um usuário Linux por pessoa:

```
useradd -m -s /bin/bash {nome}
usermod -aG docker {nome}
echo '{nome} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{nome}
chmod 440 /etc/sudoers.d/{nome}
mkdir -p /home/{nome}/.ssh && chmod 700 /home/{nome}/.ssh
# cole a CHAVE PÚBLICA da pessoa (nunca a privada) em /home/{nome}/.ssh/authorized_keys
chmod 600 /home/{nome}/.ssh/authorized_keys
chown -R {nome}:{nome} /home/{nome}/.ssh
passwd -l {nome}   # login só por chave
```

⚠️ Quem está no grupo `docker` tem, na prática, poder de root na VPS inteira
(não há como restringir o Docker a uma stack). O ganho do usuário separado é
**revogabilidade** (apagar o usuário corta o acesso daquela pessoa) e rastro
de quem fez o quê. Pela mesma razão, **nunca deixe tokens pessoais em
remotes/arquivos da VPS** — qualquer colaborador consegue lê-los; use deploy
keys read-only.

A pessoa gera a própria chave na máquina dela e manda só o `.pub`:
```
ssh-keygen -t ed25519 -C "{nome}@{empresa}"
```
