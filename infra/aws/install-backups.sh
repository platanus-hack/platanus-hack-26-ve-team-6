#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
[[ -s /etc/gotchu-backup/key && -s /etc/gotchu-backup/credentials ]] || { echo 'Install root-only backup encryption and upload credentials first.' >&2; exit 1; }
install -d -m 700 /var/lib/gotchu-backup
chmod 700 /etc/gotchu-backup
chmod 600 /etc/gotchu-backup/key /etc/gotchu-backup/credentials
chmod +x /opt/gotchu/app/infra/aws/backup.sh
cat >/etc/systemd/system/gotchu-backup.service <<'UNIT'
[Unit]
Description=Gotchu encrypted off-host recovery backup
Requires=gotchu-data.service
After=gotchu-data.service network-online.target

[Service]
Type=oneshot
ExecStart=/opt/gotchu/app/infra/aws/backup.sh
TimeoutStartSec=180
Nice=10
IOSchedulingClass=idle
UMask=0077
MemoryMax=384M
UNIT
cat >/etc/systemd/system/gotchu-backup.timer <<'UNIT'
[Unit]
Description=Back up Gotchu every ten minutes

[Timer]
OnCalendar=*:0/10
Persistent=true
RandomizedDelaySec=10
Unit=gotchu-backup.service

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now gotchu-backup.timer
systemctl start gotchu-backup.service
