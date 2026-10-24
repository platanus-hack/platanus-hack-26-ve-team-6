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

read -r test_pg_port test_redis_port test_web_port test_coordinator_port < <(node --input-type=module <<'NODE'
import { createServer } from 'node:net';
import { once } from 'node:events';
// Reserve all four simultaneously so an earlier pair cannot collide forever.
const servers = Array.from({ length: 4 }, () => createServer());
await Promise.all(servers.map(async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }));
const ports = servers.map((server) => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback port reservation failed');
  return address.port;
});
console.log(ports.join(' '));
await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
NODE
)
test_pg_password="$(openssl rand -hex 32)"
test_redis_password="$(openssl rand -hex 32)"
test_api_password="$(openssl rand -hex 32)"
test_ingest_password="$(openssl rand -hex 32)"
test_coordinator_password="$(openssl rand -hex 32)"
test_gateway_password="$(openssl rand -hex 32)"
test_executor_password="$(openssl rand -hex 32)"
test_auth_secret="$(openssl rand -hex 32)"
test_container_uid="$(id -u)"
test_container_gid="$(id -g)"
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
WEB_HOST_PORT=${test_web_port}
COORDINATOR_HOST_PORT=${test_coordinator_port}
PUBLIC_APP_URL=http://localhost:${test_web_port}
GOTCHU_CONTAINER_UID=${test_container_uid}
GOTCHU_CONTAINER_GID=${test_container_gid}
AUTH_SECRET=${test_auth_secret}
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
GOTCHU_EVENT_SIGNING_KEYS_JSON=
GOTCHU_ORGANIZATION_IDS=
GOTCHU_WORKER_URL=
GOTCHU_RUN_CAPABILITY_PRIVATE_KEY=
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
GOTCHU_EXECUTOR_ENABLED=true
GOTCHU_EXECUTOR_INTERNAL_URL=http://executor:3004
GOTCHU_EXECUTOR_INTERNAL_TOKEN=$(openssl rand -hex 32)
GOTCHU_GITHUB_WRITER_INSTALLATION_ID=1
GOTCHU_STATE_DIR=${temp_dir}/state
EOF
chmod 600 "$env_file"
mkdir -m 700 "${temp_dir}/state"
node --input-type=module - "${temp_dir}/state" <<'NODE'
import { chmod, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
const [stateDir] = process.argv.slice(2);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const writer = JSON.stringify({ id: '1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
await writeFile(`${stateDir}/github-writer-app.json`, writer, { mode: 0o600, flag: 'wx' });
await writeFile(`${stateDir}/monitoring-repositories.json`, JSON.stringify({ repositoryRoot: '/run/repos', repositories: [] }), { mode: 0o600, flag: 'wx' });
await chmod(stateDir, 0o700);
NODE
openssl rand -hex 32 > "${temp_dir}/state/scanner.secret"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Gotchu Infra Check Scanner CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -keyout "${temp_dir}/state/scanner-ca.key" \
  -out "${temp_dir}/state/scanner.crt" >/dev/null 2>&1
chmod 600 "${temp_dir}/state/scanner.secret" "${temp_dir}/state/scanner-ca.key" "${temp_dir}/state/scanner.crt"

cleanup() {
  docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

cd "$repo_root"
docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" config --quiet
docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" config --format json | node scripts/infra-compose-policy.mjs
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

if [[ ! -f packages/database/package.json ]]; then
  printf '%s\n' '@gotchu/database is required for the integrated web/coordinator live check.' >&2
  exit 2
fi
if ! command -v pnpm >/dev/null 2>&1; then
  printf '%s\n' 'pnpm is required to run the live database bootstrap check.' >&2
  exit 2
fi

INFRA_ENV_FILE="$env_file" INFRA_PROJECT_NAME="$project" scripts/infra-db-bootstrap.sh
INFRA_ENV_FILE="$env_file" INFRA_PROJECT_NAME="$project" scripts/infra-db-bootstrap.sh
printf '%s\n' 'Live database bootstrap passed on first run and repeat run, including role capabilities, ownership, exact memberships, and login connectivity.'

docker compose -p "$project" --profile web --profile coordinator --profile executor --env-file "$env_file" -f "$compose_file" build web coordinator executor
# Compose tags an unnamed service image as <project>-<service>; run the bundled runtime checks before waiting on app readiness.
coordinator_image="${project}-coordinator"
executor_image="${project}-executor"
docker image inspect "$coordinator_image" >/dev/null
docker image inspect "$executor_image" >/dev/null
docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" config --format json | node scripts/infra-check.mjs "$coordinator_image" "$executor_image"
docker compose -p "$project" --profile web --profile coordinator --profile executor --env-file "$env_file" -f "$compose_file" up -d web coordinator executor

node --input-type=module - "$test_web_port" "$test_coordinator_port" <<'NODE'
import assert from 'node:assert/strict';

const [webPort, coordinatorPort] = process.argv.slice(2);
const until = Date.now() + 90_000;
let webHealth;
let coordinatorLive;
while (Date.now() < until) {
  try {
    webHealth = await fetch(`http://127.0.0.1:${webPort}/api/health`, { signal: AbortSignal.timeout(3_000) });
    coordinatorLive = await fetch(`http://127.0.0.1:${coordinatorPort}/health/live`, { signal: AbortSignal.timeout(3_000) });
    if (webHealth.ok && coordinatorLive.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
assert.equal(webHealth?.status, 200, 'built web /api/health route did not start');
assert.equal(coordinatorLive?.status, 200, 'built coordinator /health/live route did not start');
const webReady = await fetch(`http://127.0.0.1:${webPort}/api/ready`);
const webBody = await webReady.json();
assert.equal(webReady.status, 503, 'web should remain unready without GitHub OAuth');
assert.equal(webBody.ready, false);
assert.equal(webBody.dependencies.apiDatabase, true, 'web API database runtime login did not connect');
assert.equal(webBody.dependencies.intakeDatabase, true, 'web ingestion runtime login did not connect');
assert.equal(webBody.dependencies.signIn, false, 'live check unexpectedly configured GitHub OAuth');
assert.equal(webBody.capabilities.eventSigningKeys, false, 'empty local signing map must remain unavailable');
assert.equal(webBody.capabilities.freshSecondFactorApproval, true, 'configured WebAuthn service capability must be visible without an enrolled factor');
assert.equal(webBody.capabilities.githubWrites, false, 'provider writes must remain disabled');
assert.equal(webBody.capabilities.customerCodeExecution, false, 'customer-code execution must remain disabled');
const coordinatorReady = await fetch(`http://127.0.0.1:${coordinatorPort}/health/ready`);
const coordinatorBody = await coordinatorReady.json();
assert.equal(coordinatorReady.status, 503, 'coordinator should remain unready without organization assignment');
assert.equal(coordinatorBody.status, 'unassigned');
assert.equal(coordinatorBody.assignedOrganizations, 0);
assert.equal(coordinatorBody.investigatorConfigured, false, 'worker profile must remain intentionally disabled');
process.stdout.write('Built app routes stayed unready without OAuth or organization assignment; WebAuthn capability was configured while provider writes, customer-code execution, and investigator execution remained unavailable.\n');
NODE

web_container="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps -q web)"
coordinator_container="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps -q coordinator)"
executor_container="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" ps -q executor)"
web_user="$(docker inspect --format '{{.Config.User}}' "$web_container")"
coordinator_user="$(docker inspect --format '{{.Config.User}}' "$coordinator_container")"
executor_user="$(docker inspect --format '{{.Config.User}}' "$executor_container")"
if [[ "$web_user" != "${test_container_uid}:${test_container_gid}" || "$coordinator_user" != "${test_container_uid}:${test_container_gid}" || "$executor_user" != "${test_container_uid}:${test_container_gid}" ]]; then
  printf '%s\n' 'Built applications are not running as the configured nonroot UID.' >&2
  exit 1
fi
web_workspace_owner="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T web stat -c '%u:%g' /workspace/apps/web)"
coordinator_workspace_owner="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T coordinator stat -c '%u:%g' /workspace/apps/coordinator)"
executor_workspace_owner="$(docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T executor stat -c '%u:%g' /workspace/apps/executor)"
if [[ "${web_workspace_owner%%:*}" == 0 || "${coordinator_workspace_owner%%:*}" == 0 || "${executor_workspace_owner%%:*}" == 0 ]]; then
  printf '%s\n' 'Built app work directories are root-owned.' >&2
  exit 1
fi
node scripts/infra-check-loopback-ports.mjs "$test_pg_port" "$test_redis_port" "$test_web_port" "$test_coordinator_port"
printf '%s\n' 'Built application images run nonroot and publish only on their isolated loopback ports.'

docker compose -p "$project" --env-file "$env_file" -f "$compose_file" exec -T web \
  node --input-type=module -e 'const response = await fetch("https://github.com/", { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error(`GitHub TLS probe returned ${response.status}`); process.stdout.write("Web container reached GitHub over verified HTTPS.\n");'

web_health=starting
coordinator_health=starting
executor_health=starting
for _ in $(seq 1 50); do
  web_health="$(docker inspect --format '{{.State.Health.Status}}' "$web_container")"
  coordinator_health="$(docker inspect --format '{{.State.Health.Status}}' "$coordinator_container")"
  executor_health="$(docker inspect --format '{{.State.Health.Status}}' "$executor_container")"
  if [[ "$web_health" == unhealthy && "$coordinator_health" == unhealthy && "$executor_health" == unhealthy ]]; then break; fi
  sleep 2
done
if [[ "$web_health" != unhealthy || "$coordinator_health" != unhealthy || "$executor_health" != healthy ]]; then
  printf 'Health must follow configured dependencies (web=%s, coordinator=%s, executor=%s).\n' \
    "$web_health" "$coordinator_health" "$executor_health" >&2
  exit 1
fi
printf '%s\n' 'Web and coordinator remained unhealthy without OAuth/organization assignment; the configured executor became ready.'
executor_instances="$(pg_query "SELECT count(*) FROM gotchu.action_executor_instances WHERE capability_id='repository.source_patch_pr' AND heartbeat_at>clock_timestamp()-interval '90 seconds';")"
if [[ "$executor_instances" != 1 ]]; then
  printf '%s\n' 'Executor readiness was not registered for server-side action eligibility.' >&2
  exit 1
fi

for disabled_service in agent gateway scanner-boundary; do
  set +e
  docker compose -p "$project" --profile "$(case "$disabled_service" in scanner-boundary) printf scanner ;; *) printf '%s' "$disabled_service" ;; esac)" \
    --env-file "$env_file" -f "$compose_file" run --rm --no-deps "$disabled_service" >/dev/null 2>&1
  disabled_status=$?
  set -e
  if [[ "$disabled_status" != 78 ]]; then
    printf 'Disabled service %s did not fail closed with status 78.\n' "$disabled_service" >&2
    exit 1
  fi
done
printf '%s\n' 'Agent, gateway, and scanner-boundary profiles remain explicitly disabled; the executor is opt-in and ran with an isolated writer fixture.'

docker compose -p "$project" --env-file "$env_file" -f "$compose_file" stop --timeout 20 web coordinator executor >/dev/null
web_exit="$(docker inspect --format '{{.State.ExitCode}}' "$web_container")"
coordinator_exit="$(docker inspect --format '{{.State.ExitCode}}' "$coordinator_container")"
if [[ "$web_exit" != 0 || "$coordinator_exit" != 0 ]]; then
  printf 'Graceful app shutdown failed (web=%s, coordinator=%s).\n' "$web_exit" "$coordinator_exit" >&2
  exit 1
fi
printf '%s\n' 'Web and coordinator stopped cleanly on Compose SIGTERM.'

INFRA_ENV_FILE="$env_file" INFRA_PROJECT_NAME="$project" scripts/infra-local-down.sh
remaining_containers="$(docker compose -p "$project" --profile '*' --env-file "$env_file" -f "$compose_file" ps -aq)"
remaining_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=${project}" | wc -l | tr -d ' ')"
if [[ -n "$remaining_containers" || "$remaining_volumes" != 2 ]]; then
  printf 'Local down left project containers or removed its persistent volumes (containers=%s, volumes=%s).\n' \
    "${remaining_containers:+present}" "$remaining_volumes" >&2
  exit 1
fi
printf '%s\n' 'Local down removed every app/data container and retained both local data volumes.'
