#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
exec 8>/run/lock/gotchu-maintenance.lock
flock -w 300 8 || exit 1
# Drain durable work before replacing the database used by parser containers.
scanner_active=false; coordinator_active=false
systemctl is-active --quiet gotchu@scanner && scanner_active=true
systemctl is-active --quiet gotchu@coordinator && coordinator_active=true
resume() {
  if $scanner_active; then systemctl start gotchu@scanner; fi
  if $coordinator_active; then systemctl start gotchu@coordinator; fi
}
trap resume EXIT
systemctl stop gotchu@coordinator
systemctl stop gotchu@scanner
cd /opt/gotchu/app
runuser -u gotchu-scanner -- env GOTCHU_TRIVY_DB_DIRECTORY=/var/lib/gotchu-scanner/trivy-db /usr/local/bin/node scripts/update-trivy-db.mjs
