#!/usr/bin/env bash
set -euo pipefail
for attempt in $(seq 1 120); do
  busy=false
  for unit in gotchu-backup.service gotchu-scanner-refresh.service; do
    state=$(systemctl show "$unit" --property=ActiveState --value) || exit 1
    case "$state" in
      inactive|failed) ;;
      activating|active|reloading|deactivating|refreshing) busy=true ;;
      *) echo "Unknown maintenance state for $unit: $state" >&2; exit 1 ;;
    esac
  done
  if ! $busy; then exit 0; fi
  sleep 5
done
echo 'Maintenance did not finish; retry adoption later.' >&2
exit 1
