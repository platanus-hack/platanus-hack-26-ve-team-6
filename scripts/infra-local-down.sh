#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${INFRA_ENV_FILE:-${repo_root}/infra/.env}"
compose_file="${repo_root}/infra/compose.yaml"
worktree_name="$(basename "$repo_root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
project_name="${INFRA_PROJECT_NAME:-gotchu-${worktree_name}}"

if [[ ! -f "$env_file" ]]; then
  printf '%s\n' 'infra/.env is missing; run scripts/infra-local-setup.sh first.' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI or daemon is unavailable; local infrastructure was not stopped.' >&2
  exit 2
fi

docker compose -p "$project_name" --profile '*' --env-file "$env_file" -f "$compose_file" down
printf '%s\n' 'Stopped this worktree’s local Compose project. Persistent data volumes were retained.'
