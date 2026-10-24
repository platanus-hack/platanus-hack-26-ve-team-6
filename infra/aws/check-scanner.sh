#!/usr/bin/env bash
set -euo pipefail
deadline=$((SECONDS + 150))
while (( SECONDS < deadline )); do
  if curl --silent --fail --max-time 15 --cacert /etc/gotchu/scanner.crt https://127.0.0.1:4400/readyz >/dev/null; then
    exit 0
  fi
  sleep 2
done
exit 1
