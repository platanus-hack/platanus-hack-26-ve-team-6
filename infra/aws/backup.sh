#!/usr/bin/env bash
# Root-only backup; its AWS identity can upload but cannot read or delete backup history.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || exit 1
exec 9>/var/lib/gotchu-backup/backup.lock
flock -n 9 || exit 0
app=/opt/gotchu/app
stage=$(mktemp -d /var/lib/gotchu-backup/staging.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
cd "$app"
docker compose -p gotchu-production --env-file /var/lib/gotchu-admin/state/.env -f infra/compose.yaml -f infra/aws/compose.yaml exec -T postgres \
  sh -ec 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' >"$stage/database.dump"
cp /etc/gotchu/release.txt "$stage/release.txt"
tar --exclude='*.log' --exclude='*.pid' --exclude='.backup.*' -czf "$stage/payload.tar.gz" \
  -C "$stage" database.dump release.txt \
  -C / etc/gotchu var/lib/gotchu-admin/state var/lib/gotchu-web var/lib/gotchu-coordinator
# Large backups need an operator storage review instead of unbounded accumulation.
[[ $(stat -c %s "$stage/payload.tar.gz") -le 268435456 ]] || { echo 'Backup exceeds the 256 MiB pilot storage bound.' >&2; exit 1; }
node scripts/gotchu-backup-crypto.mjs encrypt "$stage/payload.tar.gz" "$stage/backup" </etc/gotchu-backup/key
export AWS_SHARED_CREDENTIALS_FILE=/etc/gotchu-backup/credentials AWS_DEFAULT_REGION=us-east-1
export AWS_EC2_METADATA_DISABLED=true AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=3
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
aws s3 cp "$stage/backup" "s3://gotchu-prod-backups-477010601418-us-east-1/frequent/$timestamp.backup" --only-show-errors --sse AES256
today=$(date -u +%Y%m%d)
if [[ ! -f /var/lib/gotchu-backup/daily-success ]] || [[ $(cat /var/lib/gotchu-backup/daily-success) != "$today" ]]; then
  aws s3 cp "$stage/backup" "s3://gotchu-prod-backups-477010601418-us-east-1/daily/$today.backup" --only-show-errors --sse AES256
  printf '%s\n' "$today" >/var/lib/gotchu-backup/daily-success
fi
date -u +%FT%TZ >/var/lib/gotchu-backup/last-success
echo 'Encrypted PostgreSQL, runtime credentials and event keys uploaded.'
