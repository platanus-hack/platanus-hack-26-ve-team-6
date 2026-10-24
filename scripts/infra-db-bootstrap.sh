#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/infra/.env"

if [[ ! -f "$env_file" ]]; then
  printf '%s\n' 'infra/.env is missing; run scripts/infra-local-setup.sh first.' >&2
  exit 2
fi
if [[ ! -f "${repo_root}/packages/database/package.json" ]]; then
  printf '%s\n' '@gotchu/database is not in this checkout; migrations and runtime logins were not provisioned.' >&2
  exit 2
fi
if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' 'pnpm is required to build and invoke @gotchu/database.' >&2
  exit 2
fi

read_env() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$env_file")"
  if [[ -z "$value" ]]; then
    printf 'Missing %s in infra/.env.\n' "$key" >&2
    exit 2
  fi
  printf '%s' "$value"
}

postgres_password="$(read_env POSTGRES_PASSWORD)"
postgres_port="$(read_env POSTGRES_HOST_PORT)"
api_username="$(read_env GOTCHU_API_DB_USERNAME)"
api_password="$(read_env GOTCHU_API_DB_PASSWORD)"
ingest_username="$(read_env GOTCHU_INGEST_DB_USERNAME)"
ingest_password="$(read_env GOTCHU_INGEST_DB_PASSWORD)"
coordinator_username="$(read_env GOTCHU_COORDINATOR_DB_USERNAME)"
coordinator_password="$(read_env GOTCHU_COORDINATOR_DB_PASSWORD)"
gateway_username="$(read_env GOTCHU_GATEWAY_DB_USERNAME)"
gateway_password="$(read_env GOTCHU_GATEWAY_DB_PASSWORD)"
executor_username="$(read_env GOTCHU_EXECUTOR_DB_USERNAME)"
executor_password="$(read_env GOTCHU_EXECUTOR_DB_PASSWORD)"
for username in "$api_username" "$ingest_username" "$coordinator_username" "$gateway_username" "$executor_username"; do
  if [[ ! "$username" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    printf '%s\n' 'Runtime login names in infra/.env must be lowercase PostgreSQL-safe identifiers.' >&2
    exit 2
  fi
done
bootstrap_url="postgresql://gotchu_bootstrap:${postgres_password}@127.0.0.1:${postgres_port}/gotchu"
worktree_name="$(basename "$repo_root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
project_name="gotchu-${worktree_name}"

cd "$repo_root"
pnpm --filter @gotchu/database build
GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" pnpm --filter @gotchu/database migrate
existing_logins="$(docker compose -p "$project_name" --env-file "$env_file" -f "$repo_root/infra/compose.yaml" exec -T \
  -e "PGPASSWORD=${postgres_password}" postgres \
  psql -h 127.0.0.1 -U gotchu_bootstrap -d gotchu -Atq \
    -v api_username="$api_username" -v ingest_username="$ingest_username" \
    -v coordinator_username="$coordinator_username" -v gateway_username="$gateway_username" -v executor_username="$executor_username" \
    -c "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[:'api_username', :'ingest_username', :'coordinator_username', :'gateway_username', :'executor_username']);")"
if [[ "$existing_logins" == 0 ]]; then
  GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" \
    GOTCHU_API_DB_USERNAME="$api_username" GOTCHU_API_DB_PASSWORD="$api_password" \
    GOTCHU_INGEST_DB_USERNAME="$ingest_username" GOTCHU_INGEST_DB_PASSWORD="$ingest_password" \
    GOTCHU_COORDINATOR_DB_USERNAME="$coordinator_username" GOTCHU_COORDINATOR_DB_PASSWORD="$coordinator_password" \
    GOTCHU_GATEWAY_DB_USERNAME="$gateway_username" GOTCHU_GATEWAY_DB_PASSWORD="$gateway_password" \
    GOTCHU_EXECUTOR_DB_USERNAME="$executor_username" GOTCHU_EXECUTOR_DB_PASSWORD="$executor_password" \
    pnpm --filter @gotchu/database exec node "$repo_root/scripts/infra-provision-runtime-logins.mjs"
elif [[ "$existing_logins" != 5 ]]; then
  printf '%s\n' 'Found a partial set of Gotchu runtime logins; refusing to mutate existing local database roles.' >&2
  exit 1
fi
printf '%s\n' 'Database migrations and five isolated runtime logins are ready.'
