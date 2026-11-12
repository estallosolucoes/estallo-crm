#!/bin/bash
# Comando forçado da chave de deploy do CI (authorized_keys do root na VPS):
#   command="/opt/deploy-estallo.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... estallo-deploy
# A chave só consegue rodar isto. Entrada: "estallo <sha de 40 hex>" em SSH_ORIGINAL_COMMAND e, no stdin, um
# tar do repositório naquele commit (git archive), que traz docker-stack.estallo.yml e scripts/estallo-vps.py.
set -euo pipefail
read -r alvo sha extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ "$alvo" == estallo && "$sha" =~ ^[0-9a-f]{40}$ && -z "${extra:-}" ]] || { echo "alvo não permitido" >&2; exit 2; }
repo=/opt/stacks/estallo-crm/repo
mkdir -p "$repo"
tar -x -C "$repo"
cd "$repo"
exec python3 scripts/estallo-vps.py deploy --sha "$sha"
