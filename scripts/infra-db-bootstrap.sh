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
postgres_db="$(read_env POSTGRES_DB)"
postgres_user="$(read_env POSTGRES_USER)"
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
login_names=("$api_username" "$ingest_username" "$coordinator_username" "$gateway_username" "$executor_username")
declare -A seen_login_names=()
for username in "${login_names[@]}"; do
  if [[ ! "$username" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    printf '%s\n' 'Runtime login names in infra/.env must be lowercase PostgreSQL-safe identifiers.' >&2
    exit 2
  fi
  if [[ -n "${seen_login_names[$username]+present}" ]]; then
    printf '%s\n' 'Runtime login names in infra/.env must be distinct.' >&2
    exit 2
  fi
  seen_login_names[$username]=1
done
quoted_login_names="'${api_username}','${ingest_username}','${coordinator_username}','${gateway_username}','${executor_username}'"
bootstrap_url="postgresql://${postgres_user}:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_db}"

cd "$repo_root"
pnpm --filter @gotchu/database build
GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" pnpm --filter @gotchu/database migrate
compose=(docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file")
pg_query() {
  "${compose[@]}" exec -T -e "PGPASSWORD=${postgres_password}" postgres \
    psql -h 127.0.0.1 -U "$postgres_user" -d "$postgres_db" -Atq -c "$1"
}

existing_logins="$(pg_query "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[${quoted_login_names}]);")"
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

group_role_names="'gotchu_owner','gotchu_api','gotchu_ingest','gotchu_coordinator','gotchu_executor'"
unsafe_group_roles="$(pg_query "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[${group_role_names}]) AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);")"
safe_runtime_logins="$(pg_query "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[${quoted_login_names}]) AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication;")"
runtime_schema_owners="$(pg_query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='gotchu' AND r.rolname=ANY(ARRAY[${quoted_login_names}]);")"
bad_memberships="$(pg_query "SELECT count(*) FROM (VALUES ('${api_username}','gotchu_api'),('${ingest_username}','gotchu_ingest'),('${coordinator_username}','gotchu_coordinator'),('${gateway_username}','gotchu_coordinator'),('${executor_username}','gotchu_executor')) AS expected(login_name,role_name) WHERE NOT pg_has_role(login_name,role_name,'MEMBER');")"
extra_memberships="$(pg_query "SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles granted ON granted.oid=m.roleid WHERE member.rolname=ANY(ARRAY[${quoted_login_names}]) AND NOT ((member.rolname='${api_username}' AND granted.rolname='gotchu_api') OR (member.rolname='${ingest_username}' AND granted.rolname='gotchu_ingest') OR (member.rolname='${coordinator_username}' AND granted.rolname='gotchu_coordinator') OR (member.rolname='${gateway_username}' AND granted.rolname='gotchu_coordinator') OR (member.rolname='${executor_username}' AND granted.rolname='gotchu_executor'));")"
if [[ "$unsafe_group_roles" != 0 || "$safe_runtime_logins" != 5 || "$runtime_schema_owners" != 0 || "$bad_memberships" != 0 || "$extra_memberships" != 0 ]]; then
  printf '%s\n' 'Runtime role capabilities, ownership, or exact memberships do not match the expected policy.' >&2
  exit 1
fi

check_runtime_login() {
  local role="$1" username="$2" password="$3" effective_role
  effective_role="$("${compose[@]}" exec -T -e "PGPASSWORD=${password}" postgres \
    psql -h 127.0.0.1 -U "$username" -d "$postgres_db" -Atq \
    -c "BEGIN; SET LOCAL ROLE ${role}; SELECT current_user; ROLLBACK;")"
  if [[ "$effective_role" != "$role" ]]; then
    printf 'Runtime login could not connect with its isolated role: %s.\n' "$role" >&2
    exit 1
  fi
}
check_runtime_login gotchu_api "$api_username" "$api_password"
check_runtime_login gotchu_ingest "$ingest_username" "$ingest_password"
check_runtime_login gotchu_coordinator "$coordinator_username" "$coordinator_password"
check_runtime_login gotchu_coordinator "$gateway_username" "$gateway_password"
check_runtime_login gotchu_executor "$executor_username" "$executor_password"
printf '%s\n' 'Database migrations and five isolated runtime logins are ready.'
