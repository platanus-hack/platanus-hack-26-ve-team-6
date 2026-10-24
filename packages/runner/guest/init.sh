#!/bin/bash
set -eu
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /input /scratch
mount -o ro /dev/vdb /input
mount /dev/vdc /scratch
chown node:node /scratch
pids="$(/usr/local/bin/node -e "const job=JSON.parse(require('node:fs').readFileSync('/input/job.json','utf8'));process.stdout.write(String(job.limits.pids))")"
ulimit -u "$pids"
exec /usr/local/bin/node /usr/local/lib/gotchu-guest-agent.mjs
