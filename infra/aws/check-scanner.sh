#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..12}; do
  if curl --silent --fail --max-time 40 --cacert /etc/gotchu/scanner.crt https://127.0.0.1:4400/readyz >/dev/null; then
    exit 0
  fi
  sleep 2
done
exit 1
