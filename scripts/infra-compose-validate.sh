#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/infra/.env"
compose_file="${repo_root}/infra/compose.yaml"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI is unavailable; Compose validation did not run.' >&2
  exit 2
fi
if [[ ! -f "$env_file" ]]; then
  printf '%s\n' 'infra/.env is missing; run scripts/infra-local-setup.sh first.' >&2
  exit 2
fi

cd "$repo_root"
docker compose --profile '*' --env-file "$env_file" -f "$compose_file" config --quiet
docker compose --profile '*' --env-file "$env_file" -f "$compose_file" config --format json | node scripts/infra-compose-policy.mjs

docker compose --profile '*' --env-file "$env_file" -f "$compose_file" config --format json | node scripts/infra-check.mjs
