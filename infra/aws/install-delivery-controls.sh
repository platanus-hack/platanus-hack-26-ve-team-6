#!/usr/bin/env bash
# One-time operator installation; never invoked by the deployment role.
set -euo pipefail
[[ $(id -u) == 0 && ${1:-} =~ ^[a-f0-9]{40}$ ]] || exit 2
initial=$1
source=$(cd "$(dirname "$0")" && pwd)
app=/opt/gotchu/app
[[ -d $app && ! -L $app ]] || { echo 'Existing runtime already adopted; review controls separately.' >&2; exit 1; }
install -d -m 755 /usr/local/lib/gotchu-deploy /opt/gotchu/releases
install -d -m 700 /var/lib/gotchu-deploy
for helper in release-archive.py release-state.py release-db.mjs release-health.mjs; do
  install -o root -g root -m 644 "$source/$helper" "/usr/local/lib/gotchu-deploy/$helper"
done
install -o root -g root -m 750 "$source/install-release.sh" /usr/local/sbin/gotchu-install-release
printf '{"bucket":"gotchu-prod-releases-477010601418-us-east-1"}\n' >/etc/gotchu-deploy.json
chmod 600 /etc/gotchu-deploy.json
# Let in-flight maintenance finish before changing its lock contract.
trap 'systemctl start gotchu-backup.timer gotchu-scanner-refresh.timer' EXIT
systemctl stop gotchu-backup.timer gotchu-scanner-refresh.timer
bash "$source/wait-maintenance.sh"
resume() {
  systemctl start gotchu@scanner gotchu@coordinator gotchu@web
  node /usr/local/lib/gotchu-deploy/release-health.mjs
  systemctl start caddy gotchu-backup.timer gotchu-scanner-refresh.timer
}
trap resume EXIT
exec 8>/run/lock/gotchu-maintenance.lock
flock -w 180 8
marker=$(mktemp /var/lib/gotchu-deploy/backup-marker.XXXXXX)
GOTCHU_MAINTENANCE_LOCK_HELD=true "$app/infra/aws/backup.sh"
[[ /var/lib/gotchu-backup/last-success -nt $marker ]] || { echo 'A fresh completed backup is required.' >&2; exit 1; }
unlink "$marker"
systemctl stop caddy
systemctl stop gotchu@coordinator
systemctl stop gotchu@web gotchu@scanner
install -m 755 "$source/backup.sh" "$app/infra/aws/backup.sh"
install -m 755 "$source/refresh-scanners.sh" "$app/infra/aws/refresh-scanners.sh"
install -m 644 "$source/update-trivy-db.mjs" "$app/scripts/update-trivy-db.mjs"
[[ ! -e /var/lib/gotchu-scanner/trivy-db ]] || { echo 'Persistent scanner cache already exists.' >&2; exit 1; }
mv "$app/.local/dev/trivy-db" /var/lib/gotchu-scanner/trivy-db
ln -s /var/lib/gotchu-scanner/trivy-db "$app/.local/dev/trivy-db"
mv "$app" "/opt/gotchu/releases/initial-$initial"
ln -s "/opt/gotchu/releases/initial-$initial" "$app"
install -d /etc/systemd/system/gotchu@scanner.service.d
cat >/etc/systemd/system/gotchu@scanner.service.d/persistent-cache.conf <<'UNIT'
[Service]
ReadWritePaths=
ReadWritePaths=/var/lib/gotchu-scanner /tmp /var/lib/gotchu-scanner/trivy-db
UNIT
systemctl daemon-reload
echo 'Adopted existing application and installed independent delivery controls.'
