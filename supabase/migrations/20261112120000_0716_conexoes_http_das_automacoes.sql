-- manifest: conexões HTTP protegidas das automações (Fase 5) — origem + credencial cifrada (AES-GCM, AI_CRED_AES_KEY) por organização; só o servidor lê, e o bloco Requisição HTTP só chama a origem cadastrada
--
-- O bloco "Requisição HTTP" do construtor de automações nunca carrega segredo na configuração (a exportação recusa
-- segredo embutido): ele cita uma CONEXÃO por id. A conexão guarda a origem (`https://api.exemplo.com`) e, se houver,
-- a credencial — cifrada no aplicativo com AES-256-GCM e a chave da instalação (`AI_CRED_AES_KEY`, fora do banco):
-- um dump do banco sozinho não abre o segredo. É o mesmo formato de `external_db_connections`.
--
-- Mais fechada que aquela: `anon` e `authenticated` não têm GRANT nenhum — nem a cifra nem a origem saem pela REST.
-- Quem lê é o servidor (rotas /api/v1 com o client de serviço, sempre filtrando `organization_id` da sessão; e o motor
-- de automações, pela conexão do diário). A RLS fica ligada, com a política de sempre, para o dia em que alguém
-- conceder leitura por engano: mesmo assim só `admin` da própria organização alcança a linha.
--
-- Idempotente e portável em psql puro.
create table if not exists public.automation_http_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  base_url text not null check (length(base_url) <= 300 and base_url ~ '^https?://[^/?#@[:space:]]+$'),
  auth_kind text not null check (auth_kind in ('none', 'bearer', 'header', 'basic')),
  header_name text check (header_name is null or header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  secret_encrypted bytea,
  secret_iv bytea,
  secret_tag bytea,
  secret_last4 text check (secret_last4 is null or length(secret_last4) <= 4),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_http_connections_label_uk unique (organization_id, label),
  constraint automation_http_connections_segredo_completo check (
    (auth_kind = 'none') = (secret_encrypted is null)
    and (secret_encrypted is null) = (secret_iv is null)
    and (secret_iv is null) = (secret_tag is null)
  ),
  constraint automation_http_connections_cabecalho check ((auth_kind = 'header') = (header_name is not null))
);

comment on table public.automation_http_connections is
  'Conexão HTTP protegida de uma organização, citada pelo bloco Requisição HTTP das automações. A credencial é cifrada com AES-GCM (AI_CRED_AES_KEY) e só o servidor a lê; o bloco só chama a origem cadastrada.';

create index if not exists automation_http_connections_org_idx
  on public.automation_http_connections (organization_id);

alter table public.automation_http_connections enable row level security;

drop policy if exists tenant_isolation_automation_http_connections_all on public.automation_http_connections;
create policy tenant_isolation_automation_http_connections_all on public.automation_http_connections
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- O ALTER DEFAULT PRIVILEGES do baseline dá GRANT ALL em tabelas novas a anon/authenticated: revogar explicitamente.
revoke all on table public.automation_http_connections from public, anon, authenticated;
grant all on table public.automation_http_connections to service_role;

drop trigger if exists trg_automation_http_connections_updated_at on public.automation_http_connections;
create trigger trg_automation_http_connections_updated_at
  before update on public.automation_http_connections
  for each row execute function public.fn_set_updated_at();
