#!/bin/bash
set -eu
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
# Local HTTP stays inside this NIC-less VM; setup failure stops the boot.
/sbin/gotchu-loopback-up
mkdir -p /input /scratch /npm-cache-source
mount -o ro /dev/vdb /input
mount /dev/vdc /scratch
mount -o ro /dev/vdd /npm-cache-source
chown node:node /scratch
profile="$(/usr/local/bin/node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('/input/job.json','utf8')).profile)")"
if [[ "$profile" == "node24-tsx-selected-v1" ]]; then
  # Keep the pinned loader/reporter immutable; temporary fixture files use scratch.
  mkdir -p /scratch/tmp
  chmod 1777 /scratch/tmp
  mount --bind /scratch/tmp /tmp
  mount -o remount,ro /
fi
pids="$(/usr/local/bin/node -e "const job=JSON.parse(require('node:fs').readFileSync('/input/job.json','utf8'));process.stdout.write(String(job.limits.pids))")"
ulimit -u "$pids"
exec /usr/local/bin/node /usr/local/lib/gotchu-guest-agent.mjs
