#!/usr/bin/env bash
# Run as root after the operator has initialized this exact release with ./gotchu up/down.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
app=/opt/gotchu/app
state=/var/lib/gotchu-admin/state
[[ -f $state/.gotchu-state && -f $state/.env ]] || { echo 'Initialize the private operator state first.' >&2; exit 1; }
for service in web coordinator scanner; do
  id "gotchu-$service" >/dev/null 2>&1 || useradd --system --user-group --home-dir "/var/lib/gotchu-$service" --shell /usr/sbin/nologin "gotchu-$service"
  install -d -m 700 -o "gotchu-$service" -g "gotchu-$service" "/var/lib/gotchu-$service"
done
usermod -aG docker gotchu-scanner
getent group gotchu-scanner-client >/dev/null || groupadd --system gotchu-scanner-client
usermod -aG gotchu-scanner-client gotchu-scanner
usermod -aG gotchu-scanner-client gotchu-coordinator
# Web connects repositories and the coordinator monitors them with the same read-only GitHub App.
getent group gotchu-github-reader >/dev/null || groupadd --system gotchu-github-reader
usermod -aG gotchu-github-reader gotchu-web
usermod -aG gotchu-github-reader gotchu-coordinator
if [[ -d /etc/gotchu/github ]]; then
  chown -R root:gotchu-github-reader /etc/gotchu/github
  chmod 750 /etc/gotchu/github
  find /etc/gotchu/github -type f -exec chmod 640 {} +
fi
install -d -m 755 /etc/gotchu
install -m 640 -o root -g gotchu-scanner-client "$state/scanner.secret" /etc/gotchu/scanner.secret
install -m 640 -o root -g gotchu-scanner "$state/scanner.key" /etc/gotchu/scanner.key
install -m 644 -o root -g root "$state/scanner.crt" /etc/gotchu/scanner.crt
install -m 644 -o root -g root "$state/monitoring-repositories.json" /etc/gotchu/repositories.json
if [[ ! -s /etc/gotchu/web.crt || ! -s /etc/gotchu/web.key ]]; then
  (umask 077; openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout /etc/gotchu/web.key -out /etc/gotchu/web.crt -subj '/CN=gotchu-loopback' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'subjectAltName=IP:127.0.0.1') >/dev/null 2>&1
fi
chown root:gotchu-web /etc/gotchu/web.key
chmod 640 /etc/gotchu/web.key
chmod 644 /etc/gotchu/web.crt

# Environment files are read by systemd as root; runtime users receive only their service's values.
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const state = '/var/lib/gotchu-admin/state';
const config = parseEnv(readFileSync(`${state}/.env`, 'utf8'));
function required(key) {
  const value = config[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
function database(prefix) {
  const url = new URL(`postgresql://127.0.0.1:${required('POSTGRES_HOST_PORT')}/${required('POSTGRES_DB')}`);
  url.username = required(`${prefix}_DB_USERNAME`);
  url.password = required(`${prefix}_DB_PASSWORD`);
  return url.href;
}
const common = { NODE_ENV: 'production', GOTCHU_DEMO_ENABLED: 'false', GOTCHU_MONITORING_CONFIG_FILE: '/etc/gotchu/repositories.json' };
// Optional sign-in integrations belong only to web; keep operator settings across reinstalls.
const webIntegrations = Object.fromEntries([
  'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET',
  'AUTH_OIDC_ISSUER', 'AUTH_OIDC_CLIENT_ID', 'AUTH_OIDC_CLIENT_SECRET', 'AUTH_OIDC_NAME',
  'GOTCHU_GITHUB_READER_APP_FILE', 'GOTCHU_GITHUB_APP_SLUG',
].filter(key => config[key]).map(key => [key, config[key]]));
const services = {
  web: {
    ...common, ...webIntegrations, GOTCHU_SERVICE_ENTRY: '/opt/gotchu/app/apps/web/.output/server/index.mjs',
    PORT: '3000', NITRO_PORT: '3000', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
    NITRO_SSL_CERT: '/etc/gotchu/web.crt', NITRO_SSL_KEY: '/etc/gotchu/web.key',
    PUBLIC_APP_URL: 'https://gotchu.kevinbravo.com', GOTCHU_AUTH_MODE: 'public', AUTH_SECRET: required('AUTH_SECRET'),
    GOTCHU_API_DATABASE_URL: database('GOTCHU_API'), GOTCHU_INGEST_DATABASE_URL: database('GOTCHU_INGEST'),
    GOTCHU_EVENT_CREDENTIAL_DIRECTORY: '/var/lib/gotchu-web/event-credentials',
  },
  coordinator: {
    ...common, GOTCHU_SERVICE_ENTRY: '/opt/gotchu/app/apps/coordinator/dist/main.js',
    PORT: '3003', GOTCHU_COORDINATOR_HOST: '127.0.0.1', GOTCHU_CUSTOMER_DISCOVERY: 'true',
    GOTCHU_COORDINATOR_DATABASE_URL: database('GOTCHU_COORDINATOR'),
    GOTCHU_REDIS_URL: `redis://:${encodeURIComponent(required('REDIS_PASSWORD'))}@127.0.0.1:${required('REDIS_HOST_PORT')}`,
    GOTCHU_SCANNER_ORIGIN: 'https://127.0.0.1:4400', GOTCHU_SCANNER_SECRET_FILE: '/etc/gotchu/scanner.secret',
    GOTCHU_SCANNER_CA_FILE: '/etc/gotchu/scanner.crt',
    // Scheduled checks, OSV dependency advisories and CISA KEV correlation.
    GOTCHU_MONITORING_ENABLED: 'true', GOTCHU_MONITORING_OSV: 'true',
    ...(config.GOTCHU_GITHUB_READER_APP_FILE ? { GOTCHU_GITHUB_READER_APP_FILE: config.GOTCHU_GITHUB_READER_APP_FILE } : {}),
  },
  scanner: {
    NODE_ENV: 'production', GOTCHU_SERVICE_ENTRY: '/opt/gotchu/app/apps/scanner/dist/main.js',
    GOTCHU_SCANNER_HOST: '127.0.0.1', GOTCHU_SCANNER_PORT: '4400', GOTCHU_SCANNER_OSV: '1',
    GOTCHU_SCANNER_SECRET_FILE: '/etc/gotchu/scanner.secret', GOTCHU_SCANNER_TLS_CERT_FILE: '/etc/gotchu/scanner.crt',
    GOTCHU_SCANNER_TLS_KEY_FILE: '/etc/gotchu/scanner.key', GOTCHU_SCANNER_TRIVY_DB_DIRECTORY: '/opt/gotchu/app/.local/dev/trivy-db',
  },
};
for (const [name, values] of Object.entries(services)) {
  const text = Object.entries(values).map(([key, value]) => {
    if (/[\r\n"\\]/.test(value)) throw new Error(`Unsafe environment value: ${key}`);
    return `${key}="${value}"`;
  }).join('\n');
  writeFileSync(`/etc/gotchu/${name}.env`, `${text}\n`, { mode: 0o600 });
}
NODE

cat >/etc/systemd/system/gotchu-data.service <<'UNIT'
[Unit]
Description=Gotchu persistent PostgreSQL and local Redis
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/gotchu/app
ExecStart=/usr/bin/docker compose -p gotchu-production --env-file /var/lib/gotchu-admin/state/.env -f infra/compose.yaml -f infra/aws/compose.yaml up -d --wait --wait-timeout 90 postgres redis
ExecStop=/usr/bin/docker compose -p gotchu-production --env-file /var/lib/gotchu-admin/state/.env -f infra/compose.yaml -f infra/aws/compose.yaml stop postgres redis
TimeoutStartSec=120
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/gotchu@.service <<'UNIT'
[Unit]
Description=Gotchu %i
Requires=gotchu-data.service
After=gotchu-data.service network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=gotchu-%i
Group=gotchu-%i
WorkingDirectory=/opt/gotchu/app
EnvironmentFile=/etc/gotchu/%i.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=384
ExecStart=/usr/local/bin/node ${GOTCHU_SERVICE_ENTRY}
Restart=on-failure
RestartSec=10
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/gotchu-%i
ReadOnlyPaths=/opt/gotchu/app
MemoryHigh=512M
MemoryMax=640M
TasksMax=128
LimitNOFILE=4096
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

install -d /etc/systemd/system/gotchu@scanner.service.d /etc/systemd/system/gotchu@coordinator.service.d
cat >/etc/systemd/system/gotchu@scanner.service.d/scanner.conf <<'UNIT'
[Service]
# Docker bind paths must refer to the same host /tmp that the scanner writes.
ReadWritePaths=/tmp /opt/gotchu/app/.local/dev/trivy-db
# The private mkdtemp parent stays 0700; mounted source/profile files must be readable by parser UID 65534.
UMask=0022
ExecStartPost=/opt/gotchu/app/infra/aws/check-scanner.sh
TimeoutStartSec=180
UNIT
cat >/etc/systemd/system/gotchu@coordinator.service.d/scanner.conf <<'UNIT'
[Unit]
After=gotchu@scanner.service
Wants=gotchu@scanner.service
UNIT

# Keep only the scanner's cache writable; serving processes cannot modify the release.
chown -R root:root "$app"
chmod 755 "$app/.local" "$app/.local/dev"
chown gotchu-scanner:gotchu-scanner "$app/.local/dev/trivy-db"
chmod 700 "$app/.local/dev/trivy-db"
chown -R 65534:65534 "$app/.local/dev/trivy-db/db"
chmod +x "$app/infra/aws/check-scanner.sh"
chmod +x "$app/infra/aws/refresh-scanners.sh"
cat >/etc/systemd/system/gotchu-scanner-refresh.service <<'UNIT'
[Unit]
Description=Refresh pinned scanner vulnerability metadata
After=gotchu-data.service network-online.target

[Service]
Type=oneshot
ExecStart=/opt/gotchu/app/infra/aws/refresh-scanners.sh
TimeoutStartSec=600
UNIT
cat >/etc/systemd/system/gotchu-scanner-refresh.timer <<'UNIT'
[Unit]
Description=Refresh scanner metadata daily outside Venezuelan daytime

[Timer]
OnCalendar=*-*-* 07:00:00 UTC
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
UNIT
install -m 644 "$app/infra/aws/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\nRuntimeMaxUse=32M\n' >/etc/systemd/journald.conf.d/gotchu.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable --now gotchu-data gotchu@scanner gotchu@coordinator gotchu@web
systemctl enable --now gotchu-scanner-refresh.timer
systemctl enable caddy
systemctl restart caddy
