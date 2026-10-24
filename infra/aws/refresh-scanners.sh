#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
# Drain durable work before replacing the database used by parser containers.
systemctl stop gotchu@coordinator gotchu@scanner
resume() { systemctl start gotchu@scanner gotchu@coordinator; }
trap resume EXIT
cd /opt/gotchu/app
runuser -u gotchu-scanner -- /usr/local/bin/node scripts/update-trivy-db.mjs
