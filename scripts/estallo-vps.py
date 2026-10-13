#!/usr/bin/env python3
"""Operação da stack Estallo; segredos ficam fora do clone, nunca nos logs."""
import argparse
import base64
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/stacks/estallo-crm')
REPO = ROOT / 'repo'
RUNTIME = ROOT / 'runtime.env'
STATE = ROOT / 'deployment.json'
IMAGES = ('estallo-crm', 'estallo-crm-worker', 'estallo-crm-scheduler')
ORIGIN = 'https://crm.estallo.com.br'
HTTP_HEADERS = {'User-Agent': f'EstalloCRM/1.0 (+{ORIGIN})'}
PROJECT = 'https://cbeqboyfmwyjsybszaxy.supabase.co'
PG_IMAGE = 'postgres:17-alpine'


class DeploymentFailure(RuntimeError):
    def __init__(self, message, rolled_back=False):
        super().__init__(message)
        self.rolled_back = rolled_back


def image_namespace():
    # Mesma autoridade que o instalador e os gates de distribuição usam.
    return re.search(r'^IMG_NS="([^"]+)"$',
                     (REPO / 'hostgator-setup-kit/_common.sh').read_text(), re.M)[1]


def run(args, *, env=None, input=None, output=None):
    result = subprocess.run(args, cwd=REPO, env=env, input=input,
                            stdout=output or subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # stderr de psql/Docker pode conter credenciais. O log registra a etapa.
        raise RuntimeError(f'{args[0]} {args[1]} falhou (código {result.returncode})')
    return result.stdout


def load_env(path):
    values = {}
    for line in Path(path).read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match:
            raise ValueError('Configuração inválida: use CHAVE=valor, sem comandos shell')
        values[match[1]] = match[2]
    return values


def save(path, data):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        stream.write(data)
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def runtime():
    values = load_env(RUNTIME)
    if values.get('NEXT_PUBLIC_SUPABASE_URL') != PROJECT:
        raise ValueError('Projeto Supabase diferente do autorizado')
    return values


def image_tag(sha):
    validate_sha(sha)
    path = ROOT / 'image-tags.json'
    tags = json.loads(path.read_text()) if path.exists() else {}
    tag = tags.get(sha, sha)
    if tag not in (sha, sha + '-amd64'):
        raise ValueError('Tag precisa corresponder ao commit, com arquitetura AMD64 opcional')
    return tag


def register_image_tag(sha, tag):
    validate_sha(sha)
    if tag not in (sha, sha + '-amd64'):
        raise ValueError('Tag precisa corresponder ao commit, com arquitetura AMD64 opcional')
    path = ROOT / 'image-tags.json'
    tags = json.loads(path.read_text()) if path.exists() else {}
    tags[sha] = tag
    save(path, json.dumps(tags))


def pg(command, sql=None, output=None):
    url = urllib.parse.urlsplit(runtime()['SUPABASE_DB_URL'])
    if url.scheme not in ('postgres', 'postgresql') or not url.hostname or not url.password:
        raise ValueError('Conexão Postgres incompleta')
    pg_env = dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432),
                  PGUSER=urllib.parse.unquote(url.username or ''),
                  PGPASSWORD=urllib.parse.unquote(url.password),
                  PGDATABASE=url.path.lstrip('/') or 'postgres', PGSSLMODE='require')
    args = ['docker', 'run', '--rm', '-i', '--cpus', '0.5', '--memory', '256m', '--network', 'host']
    for key in ('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'):
        args += ['-e', key]
    return run(args + [PG_IMAGE] + command, env=pg_env, input=sql, output=output)


def configure(credentials):
    if RUNTIME.exists():
        raise ValueError('Configuração já existe; ela não será sobrescrita')
    values = load_env(credentials)
    required = ('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
                'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'OWNER_EMAIL', 'OWNER_PASSWORD')
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise ValueError('Faltam campos: ' + ', '.join(missing))
    if values['NEXT_PUBLIC_SUPABASE_URL'] != PROJECT:
        raise ValueError('Projeto diferente do autorizado')
    public_key = values['NEXT_PUBLIC_SUPABASE_ANON_KEY']
    if not public_key.startswith('sb_publishable_'):
        try:
            payload = public_key.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        except Exception as error:
            raise ValueError('Use a chave pública publishable ou anon no campo público') from error
        if claims.get('role') != 'anon' or claims.get('ref') != 'cbeqboyfmwyjsybszaxy':
            raise ValueError('O campo público não pode conter uma chave administrativa')
    admin_key = values['SUPABASE_SERVICE_ROLE_KEY']
    if not admin_key.startswith('sb_secret_'):
        try:
            payload = admin_key.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        except Exception as error:
            raise ValueError('Chave administrativa Supabase inválida') from error
        if claims.get('role') != 'service_role' or claims.get('ref') != 'cbeqboyfmwyjsybszaxy':
            raise ValueError('Use a chave service_role do projeto autorizado, não a chave anon')
    try:
        request = urllib.request.Request(PROJECT + '/auth/v1/admin/users?per_page=1',
                                         headers={'apikey': admin_key,
                                                  'Authorization': 'Bearer ' + admin_key})
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError('Chave administrativa recusada pelo Supabase')
    except urllib.error.HTTPError as error:
        raise ValueError('Chave administrativa recusada pelo Supabase') from error
    connection = urllib.parse.urlsplit(values['SUPABASE_DB_URL'])
    if (connection.scheme not in ('postgres', 'postgresql')
            or not (connection.hostname or '').endswith('.pooler.supabase.com')
            or connection.port != 5432
            or urllib.parse.unquote(connection.username or '') != 'postgres.cbeqboyfmwyjsybszaxy'
            or not connection.password or '[YOUR-PASSWORD]' in values['SUPABASE_DB_URL']):
        raise ValueError('Use o Session pooler na porta 5432 do projeto autorizado, com senha preenchida')
    if len(values['OWNER_PASSWORD']) < 12:
        raise ValueError('A senha inicial precisa de pelo menos 12 caracteres')
    values.update(APP_NAME='Estallo CRM', APP_LOCALE='pt-BR', OWNER_ORG_NAME='Estallo',
                  NEXT_PUBLIC_APP_URL=ORIGIN, NEXT_PUBLIC_ADMIN_URL=ORIGIN,
                  NODE_ENV='production', SENTRY_DSN='off',
                  WAHA_API_BASE_URL='http://waha:3000', WAHA_WEBHOOK_BASE_URL=ORIGIN,
                  WAHA_WEBHOOK_REQUIRE_SIGNATURE='true', EVENT_LOG_WORKER_DRAINS='true',
                  UPSTASH_REDIS_REST_URL='http://srh:80')
    for key in ('INTERNAL_SECRET', 'INTERNAL_CRON_SECRET', 'CPF_ENCRYPTION_KEY',
                'WAHA_BYO_ENCRYPTION_KEY', 'AI_CRED_AES_KEY', 'IMPERSONATE_COOKIE_SECRET',
                'LGPD_SIGNING_KEY', 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY', 'WAHA_HMAC_SECRET',
                'WAHA_API_KEY', 'SRH_TOKEN'):
        if not values.get(key):
            values[key] = secrets.token_hex(32)
    values['WAHA_API_KEY_SHA512'] = hashlib.sha512(values['WAHA_API_KEY'].encode()).hexdigest()
    values['UPSTASH_REDIS_REST_TOKEN'] = values['SRH_TOKEN']
    save(ROOT / 'owner.env', ''.join(f'{key}={values.pop(key)}\n'
                                    for key in ('OWNER_EMAIL', 'OWNER_PASSWORD')))
    save(RUNTIME, ''.join(f'{key}={value}\n' for key, value in values.items()))
    print('Configuração protegida preparada; valores não exibidos.')


def bootstrap(sha):
    # Retoma só uma instalação cujo baseline completo foi confirmado neste host.
    # Nunca trata um banco alheio ou uma aplicação parcial como bootstrap válido.
    marker = ROOT / 'database-bootstrap.json'
    baseline = (REPO / 'supabase/baseline.sql').read_bytes()
    digest = hashlib.sha256(baseline).hexdigest()
    check = pg(['psql', '-At', '-v', 'ON_ERROR_STOP=1'],
               b"select count(*) from pg_tables where schemaname='public';\n")
    if int(check.strip()) != 0:
        if not marker.exists() or json.loads(marker.read_text()) != dict(project=PROJECT, baseline_sha256=digest):
            raise ValueError('Banco já tem tabelas; bootstrap recusado para preservar os dados')
        fresh = False
    else:
        fresh = True
    pull(sha)
    if fresh:
        pg(['psql', '-v', 'ON_ERROR_STOP=1'],
           b'create extension if not exists vector with schema public; '
           b'create extension if not exists citext with schema public; '
           b'create extension if not exists pg_trgm with schema public;\n')
        pg(['psql', '-v', 'ON_ERROR_STOP=1'], baseline)
        save(marker, json.dumps(dict(project=PROJECT, baseline_sha256=digest)))
    run(['docker', 'run', '--rm', '--env-file', str(RUNTIME),
         '--env-file', str(ROOT / 'owner.env'),
         f'{image_namespace()}/estallo-crm-worker:{image_tag(sha)}',
         'pnpm', 'exec', 'tsx', 'scripts/bootstrap-owner.ts'])
    # A org inicial usa o fuso solicitado; nenhuma outra organização é alterada.
    pg(['psql', '-v', 'ON_ERROR_STOP=1'],
       b"update public.organizations set timezone='America/Bahia' where slug='estallo';\n")
    print('Schema aplicado e administrador criado.')


def validate_sha(sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Use o SHA completo e imutável do commit')
    return sha


def pull(sha):
    validate_sha(sha)
    for image in IMAGES:
        run(['docker', 'pull', f'{image_namespace()}/{image}:{image_tag(sha)}'])


def available_memory():
    match = re.search(r'^MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text(), re.M)
    return int(match[1]) // 1024


def migrate(previous, target):
    # O baseline é a instalação do zero; reexecutar o dump com ON_ERROR_STOP
    # em banco existente abortaria nas tabelas que já existem.
    changes = run(['git', 'diff', '--name-status', previous, target, '--',
                   'supabase/migrations/*.sql']).decode().splitlines()
    for change in changes:
        kind, filename = change.split('\t', 1)
        if kind != 'A':
            raise RuntimeError('Migration aplicada foi alterada; atualização recusada')
        pg(['psql', '--single-transaction', '-v', 'ON_ERROR_STOP=1'],
           run(['git', 'show', f'{target}:{filename}']))


def containers():
    ids = run(['docker', 'ps', '-q', '--filter', 'label=com.docker.stack.namespace=estallo-crm'])
    if not ids.strip():
        return []
    return json.loads(run(['docker', 'inspect'] + ids.decode().split()))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def status_code(path):
    try:
        request = urllib.request.Request(ORIGIN + path, headers=HTTP_HEADERS)
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def healthy(expected_sha=None):
    live = containers()
    if len(live) != 6 or any(not c['State']['Running'] or c['State'].get('OOMKilled')
                             or c['State'].get('Health', {}).get('Status', 'healthy') != 'healthy'
                             for c in live):
        return False
    services = {c.get('Config', {}).get('Labels', {}).get('com.docker.swarm.service.name'): c for c in live}
    if set(services) != {'estallo-crm_' + name for name in ('app', 'worker', 'scheduler', 'waha', 'redis', 'srh')}:
        return False
    if expected_sha:
        for service, image in zip(('app', 'worker', 'scheduler'), IMAGES):
            actual = services['estallo-crm_' + service]['Config'].get('Image', '').split('@')[0]
            if actual != f'{image_namespace()}/{image}:{image_tag(expected_sha)}':
                return False
    try:
        if status_code('/') != 200 or status_code('/app') != 307:
            return False
        request = urllib.request.Request(ORIGIN + '/api/v1/health', headers=HTTP_HEADERS)
        with urllib.request.urlopen(request, timeout=15) as response:
            health = json.load(response)['data']
        return health['status'] == 'healthy' and (not expected_sha or health['version'] == expected_sha)
    except (urllib.error.URLError, OSError, json.JSONDecodeError, KeyError):
        # Emissão do certificado e dependências aquecendo não abortam a primeira
        # tentativa; o prazo e a margem de memória continuam obrigatórios.
        return False


def wait_healthy(sha):
    low_memory = 0
    for _ in range(36):
        low_memory = low_memory + 1 if available_memory() < 512 else 0
        if low_memory >= 3:
            raise RuntimeError('Memória disponível abaixo de 512 MB por 30 segundos')
        if healthy(sha):
            # Observe também após a convergência, não apenas na primeira resposta.
            for _ in range(6):
                time.sleep(10)
                if available_memory() < 512 or not healthy(sha):
                    raise RuntimeError('Piloto não manteve saúde e margem de memória')
            return
        time.sleep(10)
    raise RuntimeError('Stack não convergiu ou domínio/dependências não ficaram saudáveis')


def stack(sha):
    values = dict(os.environ, **runtime(), ESTALLO_IMAGE_TAG=image_tag(sha))
    run(['docker', 'stack', 'deploy', '--with-registry-auth', '--resolve-image', 'always',
         '-c', str(REPO / 'docker-stack.estallo.yml'), 'estallo-crm'], env=values)


def storage_backup(destination):
    # Dump SQL guarda os metadados; os bytes são baixados separadamente.
    values = runtime()
    headers = {'Authorization': 'Bearer ' + values['SUPABASE_SERVICE_ROLE_KEY'],
               'apikey': values['SUPABASE_SERVICE_ROLE_KEY'], 'Content-Type': 'application/json'}
    base = PROJECT + '/storage/v1'

    def request(path, payload=None):
        return urllib.request.urlopen(urllib.request.Request(
            base + path, headers=headers,
            data=json.dumps(payload).encode() if payload is not None else None), timeout=60)

    objects = []
    directory = destination / 'storage'
    directory.mkdir(mode=0o700)
    with request('/bucket') as response:
        buckets = json.load(response)
    for bucket in buckets:
        identifier = bucket['id']
        pending = ['']
        while pending:
            prefix = pending.pop()
            offset = 0
            while True:
                with request('/object/list/' + urllib.parse.quote(identifier, safe=''),
                             dict(prefix=prefix, limit=1000, offset=offset,
                                  sortBy=dict(column='name', order='asc'))) as response:
                    page = json.load(response)
                for item in page:
                    name = prefix + item['name']
                    if item.get('id') is None:
                        pending.append(name + '/')
                        continue
                    filename = hashlib.sha256((identifier + '/' + name).encode()).hexdigest()
                    with request('/object/' + urllib.parse.quote(identifier, safe='') + '/' +
                                 urllib.parse.quote(name, safe='/')) as response:
                        with (directory / filename).open('wb') as stream:
                            shutil.copyfileobj(response, stream)
                    objects.append(dict(bucket=identifier, name=name, file=filename,
                                        content_type=item.get('metadata', {}).get('mimetype')))
                if len(page) < 1000:
                    break
                offset += len(page)
    save(directory / 'manifest.json', json.dumps(dict(buckets=buckets, objects=objects)))


def backup():
    destination = ROOT / 'backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination.mkdir(parents=True, mode=0o700)
    partial = destination / 'database.partial'
    with partial.open('wb') as stream:
        pg(['pg_dump', '--format=custom', '--no-owner'], output=stream)
    run(['docker', 'run', '--rm', '-v', f'{partial}:/backup:ro',
         PG_IMAGE, 'pg_restore', '--list', '/backup'])
    partial.rename(destination / 'database.dump')
    # Sessões pareadas são credenciais e precisam acompanhar o backup do banco.
    for volume in ('waha-data', 'waha-media'):
        name = 'estallo-crm_' + volume
        exists = run(['docker', 'volume', 'ls', '-q', '--filter', f'name=^{name}$']).strip()
        if exists:
            with (destination / f'{volume}.tgz').open('wb') as stream:
                run(['docker', 'run', '--rm', '-v', f'{name}:/data:ro',
                     'alpine:3.20', 'tar', 'czf', '-', '-C', '/data', '.'], output=stream)
    storage_backup(destination)
    shutil.copy2(RUNTIME, destination / 'runtime.env')
    if STATE.exists():
        shutil.copy2(STATE, destination / 'deployment.json')
    for filename in ('image-tags.json',):
        if (ROOT / filename).exists():
            shutil.copy2(ROOT / filename, destination / filename)
    for file in destination.rglob('*'):
        file.chmod(0o700 if file.is_dir() else 0o600)
    target = runtime().get('BACKUP_SSH_TARGET')
    if target:
        if not re.fullmatch(r'[a-zA-Z0-9_.@-]+:/[a-zA-Z0-9_./-]+', target):
            raise ValueError('Destino de backup inválido')
        run(['scp', '-B', '-r', str(destination), target])
        print('Backup criado e copiado para destino externo.')
    else:
        print('Backup local criado; destino SSH não configurado. Cópia pelo computador é conferida no log externo.')
    return destination


def deploy(sha, backup_ready=False):
    validate_sha(sha)
    previous = state()
    if available_memory() < 1024:
        raise RuntimeError('Menos de 1 GB disponível antes do deploy; piloto recusado')
    pull(sha)
    if previous.get('sha') and not backup_ready:
        backup()
    try:
        stack(sha)
        wait_healthy(sha)
    except Exception as error:
        if previous.get('sha'):
            stack(previous['sha'])
            wait_healthy(previous['sha'])
            raise DeploymentFailure(str(error), rolled_back=True) from error
        else:
            # Interrompe somente o piloto; volumes e serviços alheios permanecem.
            run(['docker', 'service', 'scale'] +
                [f'estallo-crm_{service}=0' for service in ('app', 'worker', 'scheduler', 'waha', 'redis', 'srh')])
        raise DeploymentFailure(str(error)) from error
    save(STATE, json.dumps({'sha': sha, 'previous_sha': previous.get('sha'),
                           'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}))
    print('Deploy validado: stack saudável, HTTPS e margem de memória conferidos.')


def post(payload):
    values = runtime()
    request = urllib.request.Request(ORIGIN + '/api/v1/system/agent',
                                    data=json.dumps(payload).encode(), method='POST',
                                    headers={'Content-Type': 'application/json',
                                             **HTTP_HEADERS,
                                             'Authorization': 'Bearer ' + values['INTERNAL_CRON_SECRET']})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)['data']


def agent():
    current = state().get('sha', '')
    if not current:
        raise RuntimeError('Sem implantação validada; heartbeat recusado')
    comparison_failed = False
    latest = current
    try:
        run(['git', 'fetch', '--quiet', 'origin', 'main'])
        candidate = run(['git', 'rev-parse', 'origin/main']).decode().strip()
        # Só anuncia quando TODAS as imagens imutáveis existem no registro.
        for image in IMAGES:
            run(['docker', 'manifest', 'inspect', f'{image_namespace()}/{image}:{image_tag(candidate)}'])
        latest = candidate
    except Exception:
        comparison_failed = True
    receipt = post(dict(kind='heartbeat', current_version=current, current_sha=current,
                        latest_version=latest, off_release=False, compare_failed=comparison_failed,
                        has_known_release=True, changelog=''))
    if not receipt.get('update_requested'):
        return
    run_id = receipt['run_id']
    status = 'failed'
    message = 'Atualização não executada: não foi possível conferir as imagens.'
    try:
        if comparison_failed or latest == current:
            raise RuntimeError(message)
        post(dict(kind='run_progress', run_id=run_id, step='backup'))
        backup()
        post(dict(kind='run_progress', run_id=run_id, step='codigo'))
        # Sem checkout sobre a árvore em operação: a nova receita vem da revisão exata.
        if run(['git', 'status', '--porcelain']).strip():
            raise RuntimeError('Clone com alterações locais; atualização recusada')
        run(['git', 'merge', '--ff-only', latest])
        post(dict(kind='run_progress', run_id=run_id, step='banco'))
        migrate(current, latest)
        deploy(latest, backup_ready=True)
        status, message = 'success', 'Banco e três imagens atualizados; saúde conferida.'
    except Exception as error:
        message = str(error)
        if isinstance(error, DeploymentFailure) and error.rolled_back:
            status = 'failed_rolled_back'
    for attempt in range(12):
        try:
            post(dict(kind='run_result', run_id=run_id, status=status, log_tail=message[:16000]))
            return
        except Exception:
            if attempt == 11:
                raise RuntimeError('Não foi possível devolver o resultado da atualização à tela')
            time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['configure', 'bootstrap', 'deploy', 'rollback', 'backup', 'agent', 'verify'])
    parser.add_argument('--credentials')
    parser.add_argument('--sha')
    parser.add_argument('--image-tag')
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    with (ROOT / 'operation.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.image_tag:
            if args.action not in ('bootstrap', 'deploy'):
                raise ValueError('--image-tag só é usado no bootstrap ou deploy')
            register_image_tag(args.sha or '', args.image_tag)
        if args.action == 'configure':
            configure(args.credentials)
        elif args.action == 'bootstrap':
            bootstrap(validate_sha(args.sha or ''))
        elif args.action == 'deploy':
            deploy(validate_sha(args.sha or ''))
        elif args.action == 'rollback':
            deploy(validate_sha(state().get('previous_sha') or ''))
        elif args.action == 'backup':
            backup()
        elif args.action == 'agent':
            agent()
        elif not healthy(state().get('sha')):
            raise RuntimeError('Verificação de saúde reprovada')
        else:
            print('Saúde e domínio conferidos.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exceções externas podem conter URLs com senha: reporte só mensagens nossas.
        safe = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        print('Estallo CRM: ' + safe, file=sys.stderr)
        sys.exit(1)
