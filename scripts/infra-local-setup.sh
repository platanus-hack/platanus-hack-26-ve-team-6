#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/infra/.env"

if [[ -e "$env_file" ]]; then
  printf '%s\n' 'Local infrastructure credentials already exist at infra/.env; refusing to overwrite them.' >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'openssl is required to generate local credentials.' >&2
  exit 2
fi

umask 077
tmp_file="$(mktemp "${repo_root}/infra/.env.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

{
  printf 'POSTGRES_DB=gotchu\n'
  printf 'POSTGRES_USER=gotchu_bootstrap\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'POSTGRES_HOST_PORT=55432\n'
  printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'REDIS_HOST_PORT=56379\n'
  printf 'WEB_HOST_PORT=3000\n'
  printf 'COORDINATOR_HOST_PORT=3003\n'
  printf 'PUBLIC_APP_URL=http://localhost:3000\n'
  printf 'AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'GOTCHU_EVENT_SIGNING_KEYS_JSON=\n'
  printf 'GOTCHU_API_DB_USERNAME=gotchu_api_login\n'
  printf 'GOTCHU_API_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'GOTCHU_INGEST_DB_USERNAME=gotchu_ingest_login\n'
  printf 'GOTCHU_INGEST_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'GOTCHU_COORDINATOR_DB_USERNAME=gotchu_coordinator_login\n'
  printf 'GOTCHU_COORDINATOR_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'GOTCHU_GATEWAY_DB_USERNAME=gotchu_gateway_login\n'
  printf 'GOTCHU_GATEWAY_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'GOTCHU_RUN_CAPABILITY_PUBLIC_KEY=\n'
  printf 'GOTCHU_EXECUTOR_DB_USERNAME=gotchu_executor_login\n'
  printf 'GOTCHU_EXECUTOR_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
} > "$tmp_file"

chmod 600 "$tmp_file"
mv "$tmp_file" "$env_file"
trap - EXIT
printf '%s\n' 'Generated local credentials in infra/.env (permissions 0600). Values were not printed.'
printf '%s\n' 'Local service ports: PostgreSQL 127.0.0.1:55432, Redis 127.0.0.1:56379, web profile 127.0.0.1:3000, coordinator profile 127.0.0.1:3003.'
