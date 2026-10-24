#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/infra/.env"
compose_file="${repo_root}/infra/compose.yaml"
worktree_name="$(basename "$repo_root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
project_name="gotchu-${worktree_name}"

if [[ ! -f "$env_file" ]]; then
  printf '%s\n' 'infra/.env is missing; run scripts/infra-local-setup.sh first.' >&2
  exit 2
fi
"${repo_root}/scripts/infra-compose-validate.sh"
cd "$repo_root"
docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file" up -d postgres redis
redis_password="$(sed -n 's/^REDIS_PASSWORD=//p' "$env_file")"
ready=0
for _ in $(seq 1 60); do
  if docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file" exec -T postgres pg_isready -h 127.0.0.1 -U gotchu_bootstrap -d gotchu >/dev/null 2>&1 \
    && docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file" exec -T -e "REDISCLI_AUTH=${redis_password}" redis redis-cli ping 2>/dev/null | grep -qx PONG; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  printf '%s\n' 'PostgreSQL or Redis did not become healthy; database initialization did not run.' >&2
  exit 1
fi
if [[ -f "${repo_root}/packages/database/package.json" ]]; then
  "${repo_root}/scripts/infra-db-bootstrap.sh"
else
  printf '%s\n' '@gotchu/database is not in this checkout; runtime DB roles are not provisioned and app profiles remain unavailable.'
fi
printf '%s\n' 'PostgreSQL and Redis are healthy. Run scripts/infra-live-check.sh for isolated persistence and role checks.'
