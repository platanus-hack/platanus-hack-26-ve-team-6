#!/usr/bin/env bash
# Installed separately as a root-owned control, outside archives supplied by CI.
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $# == 2 ]] || exit 2
release=$1; checksum=$2
[[ $release =~ ^[a-f0-9]{40}-[0-9]{1,20}-[0-9]{1,5}$ && $checksum =~ ^[a-f0-9]{64}$ ]] || exit 2
exec 8>/run/lock/gotchu-maintenance.lock
flock -w 600 8 || { echo 'Another maintenance operation is still active.' >&2; exit 1; }
base=/var/lib/gotchu-deploy
helpers=/usr/local/lib/gotchu-deploy
install -d -m 700 "$base" "$base/transactions"
decision=$(python3 - "$base/state.json" "$release" "$checksum" <<'PY'
import json,sys
from pathlib import Path
path,release,checksum=sys.argv[1:]
if not Path(path).exists():
    print('install');sys.exit()
state=json.loads(Path(path).read_text())
if state['status'] in ['installing','recovery_required']:
    raise SystemExit('An unfinished deployment requires operator reconciliation')
if state['release']==release and state['checksum']==checksum and state['status']=='succeeded':
    print('current');sys.exit()
generation=lambda value: tuple(map(int,value.split('-')[1:]))
if generation(release)<=generation(state['release']):
    raise SystemExit('Stale or repeated deployment rejected; rerun with a new attempt')
print('install')
PY
)
if [[ $decision == current ]]; then
  [[ $(readlink -f /opt/gotchu/app) == "/opt/gotchu/releases/$release" ]] || exit 1
  node "$helpers/release-health.mjs"
  echo 'Release already installed and healthy.'
  exit 0
fi
previous=$(readlink -f /opt/gotchu/app)
[[ $previous == /opt/gotchu/releases/* && -d $previous ]] || { echo 'Adopt the existing release before deploying.' >&2; exit 1; }
target="/opt/gotchu/releases/$release"
[[ ! -e $target ]] || { echo 'Release directory already exists; reconcile it first.' >&2; exit 1; }
transaction="$base/transactions/$release"
install -d -m 700 "$transaction" "$target"
stopped=false
record() {
  python3 - "$base/state.json" "$1" "$release" "$checksum" "$previous" <<'PY'
import json,os,sys,time
path,status,release,checksum,previous=sys.argv[1:]
with open(path+'.tmp','w') as file:
    json.dump(dict(status=status,release=release,checksum=checksum,previous=previous,updatedAt=time.time()),file)
    file.flush();os.fsync(file.fileno())
os.replace(path+'.tmp',path)
PY
}
switch_to() {
  ln -s "$1" /opt/gotchu/.app-next
  mv -Tf /opt/gotchu/.app-next /opt/gotchu/app
}
start_runtime() {
  systemctl reset-failed gotchu@scanner gotchu@coordinator gotchu@web
  systemctl start gotchu@scanner
  systemctl start gotchu@coordinator gotchu@web
  node "$helpers/release-health.mjs"
}
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    if $stopped; then
      # Never restore data or infer compatibility after an ambiguous migration outcome.
      systemctl stop caddy gotchu@web gotchu@coordinator gotchu@scanner || true
      if node "$helpers/release-db.mjs" snapshot "$previous" >"$transaction/after-failure.json" &&
          cmp -s "$transaction/before.json" "$transaction/after-failure.json"; then
        switch_to "$previous"
        if start_runtime && systemctl start caddy; then
          record failed
          echo 'Deployment failed; previous release resumed with unchanged database migrations.' >&2
        else
          systemctl stop caddy gotchu@web gotchu@coordinator gotchu@scanner || true
          record recovery_required
        fi
      else
        record recovery_required
        echo 'Database compatibility is unknown or changed; runtime remains stopped for operator recovery.' >&2
      fi
    else
      record failed
    fi
  fi
  exit "$result"
}
trap finish EXIT
record installing
bucket=$(python3 -c 'import json;print(json.load(open("/etc/gotchu-deploy.json"))["bucket"])')
export AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials AWS_CONFIG_FILE=/dev/null AWS_PROFILE=default
export AWS_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=3
aws s3api get-object --bucket "$bucket" --key "releases/$release.tar.gz" "$transaction/release.tar.gz" >/dev/null
printf '%s  %s\n' "$checksum" "$transaction/release.tar.gz" | sha256sum --check --status
python3 "$helpers/release-archive.py" "$transaction/release.tar.gz" "$target" "${release%%-*}"
install -d -m 755 "$target/.local/dev"
ln -s /var/lib/gotchu-scanner/trivy-db "$target/.local/dev/trivy-db"
node "$helpers/release-db.mjs" snapshot "$previous" >"$transaction/before.json"
GOTCHU_MAINTENANCE_LOCK_HELD=true "$previous/infra/aws/backup.sh"
# Stop public traffic until the new runtime has passed local readiness.
stopped=true
systemctl stop caddy
systemctl stop gotchu@coordinator
systemctl stop gotchu@web gotchu@scanner
node "$helpers/release-db.mjs" migrate "$target"
node "$helpers/release-db.mjs" snapshot "$target" >"$transaction/after.json"
switch_to "$target"
start_runtime
printf '%s\n' "${release%%-*}" >/etc/gotchu/release.txt
systemctl start caddy
curl --fail --silent --show-error --max-time 20 https://gotchu.kevinbravo.com/api/ready >/dev/null
record succeeded
echo "Release $release installed and healthy."
