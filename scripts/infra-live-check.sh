#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/infra/compose.yaml"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker CLI is unavailable; live Postgres/Redis checks did not run.' >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker daemon is unavailable; live Postgres/Redis checks did not run.' >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'openssl is required to generate isolated smoke-test credentials.' >&2
  exit 2
fi

docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 0.5 --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  node:24.18.1-bookworm-slim node --version >/dev/null
printf '%s\n' 'Node 24 runtime image pulled and booted with no network or elevated privileges.'

free_loopback_port() {
  node --input-type=module -e 'import net from "node:net"; const server = net.createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });'
}

test_pg_port="$(free_loopback_port)"
test_redis_port="$(free_loopback_port)"
while [[ "$test_pg_port" == "$test_redis_port" ]]; do test_redis_port="$(free_loopback_port)"; done
test_pg_password="$(openssl rand -hex 32)"
test_redis_password="$(openssl rand -hex 32)"
test_api_password="$(openssl rand -hex 32)"
test_ingest_password="$(openssl rand -hex 32)"
test_coordinator_password="$(openssl rand -hex 32)"
test_gateway_password="$(openssl rand -hex 32)"
test_executor_password="$(openssl rand -hex 32)"
test_auth_secret="$(openssl rand -hex 32)"
project="gotchu-infra-check-$(date +%s)-$$"
temp_dir="$(mktemp -d)"
env_file="${temp_dir}/compose.env"
cat > "$env_file" <<EOF
POSTGRES_DB=gotchu
POSTGRES_USER=gotchu_bootstrap
POSTGRES_PASSWORD=${test_pg_password}
POSTGRES_HOST_PORT=${test_pg_port}
REDIS_PASSWORD=${test_redis_password}
REDIS_HOST_PORT=${test_redis_port}
WEB_HOST_PORT=3000
COORDINATOR_HOST_PORT=3003
PUBLIC_APP_URL=http://localhost:3000
AUTH_SECRET=${test_auth_secret}
GOTCHU_API_DB_USERNAME=gotchu_api_login
GOTCHU_API_DB_PASSWORD=${test_api_password}
GOTCHU_INGEST_DB_USERNAME=gotchu_ingest_login
GOTCHU_INGEST_DB_PASSWORD=${test_ingest_password}
GOTCHU_COORDINATOR_DB_USERNAME=gotchu_coordinator_login
GOTCHU_COORDINATOR_DB_PASSWORD=${test_coordinator_password}
GOTCHU_GATEWAY_DB_USERNAME=gotchu_gateway_login
GOTCHU_GATEWAY_DB_PASSWORD=${test_gateway_password}
GOTCHU_RUN_CAPABILITY_PUBLIC_KEY=
GOTCHU_EXECUTOR_DB_USERNAME=gotchu_executor_login
GOTCHU_EXECUTOR_DB_PASSWORD=${test_executor_password}
EOF
chmod 600 "$env_file"

cleanup() {
  docker compose -p "$project" --env-file "$env_file" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

cd "$repo_root"
docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" config --quiet
docker compose -p "$project" --env-file "$env_file" -f "$compose_file" up -d postgres redis
printf 'Isolated Compose ports: PostgreSQL %s -> %s, Redis %s -> %s.\n' \
  "$test_pg_port" "$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" port postgres 5432)" \
  "$test_redis_port" "$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" port redis 6379)"
postgres_container="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps -q postgres)"
redis_container="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps -q redis)"
printf 'Docker port bindings: PostgreSQL %s, Redis %s.\n' \
  "$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$postgres_container")" \
  "$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$redis_container")"

pg_ready=0
redis_ready=0
for _ in $(seq 1 60); do
  if docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T postgres pg_isready -h 127.0.0.1 -U gotchu_bootstrap -d gotchu >/dev/null 2>&1; then pg_ready=1; fi
  if docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T -e "REDISCLI_AUTH=${test_redis_password}" redis redis-cli ping 2>/dev/null | grep -qx PONG; then redis_ready=1; fi
  if [[ "$pg_ready" == 1 && "$redis_ready" == 1 ]]; then break; fi
  sleep 1
done
if [[ "$pg_ready" != 1 || "$redis_ready" != 1 ]]; then
  printf '%s\n' 'Postgres or Redis did not become healthy in the isolated Compose project.' >&2
  docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps >&2
  exit 1
fi
node scripts/infra-check-loopback-ports.mjs "$test_pg_port" "$test_redis_port"

pg_query() {
  docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T \
    -e "PGPASSWORD=${test_pg_password}" postgres \
    psql -h 127.0.0.1 -U gotchu_bootstrap -d gotchu -Atqc "$1"
}
redis_command() {
  docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T \
    -e "REDISCLI_AUTH=${test_redis_password}" redis redis-cli --raw "$@"
}

postgres_version="$(pg_query "SELECT split_part(current_setting('server_version'), ' ', 1);")"
redis_version="$(redis_command INFO server | sed -n 's/^redis_version://p' | tr -d '\r' | head -n 1)"
if [[ "$postgres_version" != 17.11 || "$redis_version" != 7.4.11 ]]; then
  printf 'Postgres/Redis version mismatch (observed PostgreSQL %s, Redis %s).\n' "$postgres_version" "$redis_version" >&2
  exit 1
fi

pg_query "CREATE TABLE public.infra_persistence_check (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO public.infra_persistence_check VALUES (1, 'persisted') ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;" >/dev/null
redis_command SET gotchu:infra:persistence persisted >/dev/null
sleep 2
docker compose -p "$project" --env-file "$env_file" -f "$compose_file" restart postgres redis >/dev/null

for _ in $(seq 1 60); do
  if docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T postgres pg_isready -h 127.0.0.1 -U gotchu_bootstrap -d gotchu >/dev/null 2>&1 \
    && docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T -e "REDISCLI_AUTH=${test_redis_password}" redis redis-cli ping 2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 1
done

pg_value="$(pg_query "SELECT value FROM public.infra_persistence_check WHERE id = 1;")"
redis_value="$(redis_command GET gotchu:infra:persistence)"
if [[ "$pg_value" != persisted || "$redis_value" != persisted ]]; then
  printf '%s\n' 'Postgres/Redis persistence check failed after restart.' >&2
  exit 1
fi
node scripts/infra-check-loopback-ports.mjs "$test_pg_port" "$test_redis_port"
printf '%s\n' 'Live Postgres and Redis connectivity, loopback publishing, and restart persistence passed.'

set +e
docker compose -p "$project" --profile agent --env-file "$env_file" -f "$compose_file" run --rm --no-deps agent >/dev/null 2>&1
agent_status=$?
set -e
if [[ "$agent_status" != 78 ]]; then
  printf '%s\n' 'apps/worker profile did not fail closed as an unimplemented agent service.' >&2
  exit 1
fi
printf '%s\n' 'apps/worker profile booted its Node image and exited 78 as an intentional unimplemented service.'

if [[ -f packages/database/package.json ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    printf '%s\n' '@gotchu/database is present but pnpm is unavailable; role checks did not run.' >&2
    exit 2
  fi
  bootstrap_url="postgresql://gotchu_bootstrap:${test_pg_password}@127.0.0.1:${test_pg_port}/gotchu"
  GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" pnpm --filter @gotchu/database build
  GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" pnpm --filter @gotchu/database migrate
  GOTCHU_MIGRATION_DATABASE_URL="$bootstrap_url" \
    GOTCHU_API_DB_USERNAME=gotchu_api_login GOTCHU_API_DB_PASSWORD="$test_api_password" \
    GOTCHU_INGEST_DB_USERNAME=gotchu_ingest_login GOTCHU_INGEST_DB_PASSWORD="$test_ingest_password" \
    GOTCHU_COORDINATOR_DB_USERNAME=gotchu_coordinator_login GOTCHU_COORDINATOR_DB_PASSWORD="$test_coordinator_password" \
    GOTCHU_GATEWAY_DB_USERNAME=gotchu_gateway_login GOTCHU_GATEWAY_DB_PASSWORD="$test_gateway_password" \
    GOTCHU_EXECUTOR_DB_USERNAME=gotchu_executor_login GOTCHU_EXECUTOR_DB_PASSWORD="$test_executor_password" \
    pnpm --filter @gotchu/database exec node "$repo_root/scripts/infra-provision-runtime-logins.mjs"

  unsafe_role_count="$(pg_query "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY['gotchu_owner','gotchu_api','gotchu_ingest','gotchu_coordinator','gotchu_executor']) AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);")"
  runtime_login_count="$(pg_query "SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY['gotchu_api_login','gotchu_ingest_login','gotchu_coordinator_login','gotchu_gateway_login','gotchu_executor_login']) AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication;")"
  unsafe_owner_count="$(pg_query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'gotchu' AND r.rolname = ANY(ARRAY['gotchu_api_login','gotchu_ingest_login','gotchu_coordinator_login','gotchu_gateway_login','gotchu_executor_login']);")"
  bad_membership_count="$(pg_query "SELECT count(*) FROM (VALUES ('gotchu_api_login','gotchu_api'),('gotchu_ingest_login','gotchu_ingest'),('gotchu_coordinator_login','gotchu_coordinator'),('gotchu_gateway_login','gotchu_coordinator'),('gotchu_executor_login','gotchu_executor')) AS membership(login_name, role_name) WHERE NOT pg_has_role(login_name, role_name, 'MEMBER');")"
  if [[ "$unsafe_role_count" != 0 || "$runtime_login_count" != 5 || "$unsafe_owner_count" != 0 || "$bad_membership_count" != 0 ]]; then
    printf '%s\n' 'Runtime role capability or membership check failed.' >&2
    exit 1
  fi

  check_runtime_login() {
    local role="$1" username="$2" password="$3"
    local effective_role
    effective_role="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T \
      -e "PGPASSWORD=${password}" postgres \
      psql -h 127.0.0.1 -U "$username" -d gotchu -Atq -c "BEGIN; SET LOCAL ROLE ${role}; SELECT current_user; ROLLBACK;")"
    if [[ "$effective_role" != "$role" ]]; then
      printf 'Runtime login could not connect with its isolated role: %s.\n' "$role" >&2
      exit 1
    fi
  }
  check_runtime_login gotchu_api gotchu_api_login "$test_api_password"
  check_runtime_login gotchu_ingest gotchu_ingest_login "$test_ingest_password"
  check_runtime_login gotchu_coordinator gotchu_coordinator_login "$test_coordinator_password"
  check_runtime_login gotchu_coordinator gotchu_gateway_login "$test_gateway_password"
  check_runtime_login gotchu_executor gotchu_executor_login "$test_executor_password"
  printf '%s\n' 'Live migration, least-privilege login flags, table ownership, role membership, and connectivity passed.'
else
  printf '%s\n' 'SKIP runtime role checks: packages/database is not in this checkout; local Postgres/Redis checks above were live.'
fi
