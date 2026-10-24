#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${GOTCHU_ENV_FILE:-${repo_root}/infra/.env}"
env_directory="$(dirname "$env_file")"

if [[ -e "$env_file" ]]; then
  printf 'Local infrastructure credentials already exist at %s; refusing to overwrite them.\n' "$env_file" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'openssl is required to generate local credentials.' >&2
  exit 2
fi

umask 077
tmp_file="$(mktemp "${env_directory}/.env.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

{
  printf 'POSTGRES_DB=gotchu\n'
  printf 'POSTGRES_USER=gotchu_bootstrap\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'POSTGRES_HOST_PORT=%s\n' "${GOTCHU_POSTGRES_PORT:-55432}"
  printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'REDIS_HOST_PORT=%s\n' "${GOTCHU_REDIS_PORT:-56379}"
  printf 'WEB_HOST_PORT=%s\n' "${GOTCHU_WEB_PORT:-3000}"
  printf 'COORDINATOR_HOST_PORT=%s\n' "${GOTCHU_COORDINATOR_PORT:-3003}"
  printf 'SCANNER_HOST_PORT=%s\n' "${GOTCHU_SCANNER_PORT:-4400}"
  printf 'EXECUTOR_HOST_PORT=%s\n' "${GOTCHU_EXECUTOR_PORT:-3004}"
  printf 'PUBLIC_APP_URL=%s\n' "${GOTCHU_PUBLIC_URL:-http://localhost:${GOTCHU_WEB_PORT:-3000}}"
  printf 'GOTCHU_AUTH_MODE=%s\n' "${GOTCHU_AUTH_MODE:-development}"
  printf 'GOTCHU_CUSTOMER_DISCOVERY=%s\n' "${GOTCHU_CUSTOMER_DISCOVERY:-false}"
  printf 'GOTCHU_CONTAINER_UID=%s\n' "$(id -u)"
  printf 'GOTCHU_CONTAINER_GID=%s\n' "$(id -g)"
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
  printf 'GOTCHU_EXECUTOR_ENABLED=false\n'
  printf 'GOTCHU_GITHUB_WRITER_INSTALLATION_ID=\n'
} > "$tmp_file"

chmod 600 "$tmp_file"
mv "$tmp_file" "$env_file"
trap - EXIT
printf 'Local credentials are private in %s (permissions 0600). Values were not printed.\n' "$env_file"
