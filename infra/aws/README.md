# Gotchu: single-server AWS deployment

The operator selected the **$24/month, 4 GB Lightsail server** for the first Venezuelan users. This supersedes the research report's initial 8 GB recommendation. Keep this topology small and measure before increasing concurrency. There is one host and no failover; a host or availability-zone outage interrupts the application.

## Resources and costs

- Region `us-east-1`; instance `gotchu-prod`, Ubuntu 24.04 x86_64, bundle `medium_3_0` (2 vCPU, 4 GB RAM, 80 GB SSD, 4 TB transfer allowance).
- Attached static IPv4 `gotchu-prod-ip`: `54.81.195.116`. Cloudflare DNS: `A gotchu → 54.81.195.116`, DNS only. HTTPS origin: `https://gotchu.kevinbravo.com`.
- Private backup bucket `gotchu-prod-backups-477010601418-us-east-1`, SSE-S3 encryption, public access blocked and TLS required.
- Resource tag `Project=gotchu`; cost-allocation tag activated. Budget `gotchu-production-monthly`: $35/month, actual notifications at 70/85/100% and forecast at 100%, using the existing billing notification recipient. Other applications and their budget were preserved.

The server is $24/month before tax; small backups should keep the starting total around **$25–30/month**, depending on retained data. This estimate excludes excess transfer and future growth. Credits/free trials are not assumed. S3 Standard in this region is $0.023/GB-month plus requests. Budget notifications lag, and cost-allocation tags can take time to populate: **$35 is an alert budget, not a billing cap**. No ALB, NAT gateway, managed Redis/RDS, autoscaling or model service is provisioned.

Sources: [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), [budget limitations](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html). Venezuelan ISP latency and production capacity still require measurements from real users.

## Runtime and credentials

`/opt/gotchu/app` is the read-only release. Node 24.20.0 and pnpm 11.21.0 are installed; dependencies use the committed frozen lockfile. Source and generated builds are transferred separately; generated output is never committed.

PostgreSQL and Redis use the existing Compose volumes under project `gotchu-production`, with [the small-host override](compose.yaml). PostgreSQL is limited to 512 MiB; Redis to 128 MiB with a 96 MiB `noeviction` limit. Redis is local transport for BullMQ; PostgreSQL remains the durable job/outbox authority. There is no separate Redis service bill.

`install-services.sh` installs `gotchu-data` and individual `gotchu@web`, `gotchu@coordinator`, `gotchu@scanner` units. Each Node service has its own Unix user, private state directory and service-specific environment; only the scanner user joins Docker. Runtime environment files are root-only under `/etc/gotchu`. The operator's migration credentials and original bootstrap state live under `/var/lib/gotchu-admin/state` (0700).

Caddy terminates and renews public TLS, bounds request sizes/timeouts, and removes URLs/headers from proxy error logs. All app/data listeners remain loopback. Public ingress permits 80/443; SSH is key-only and restricted to the deployment operator's source IP in Lightsail. Change the SSH rule deliberately when that IP changes. Journald and container logs have finite limits.

The loopback web hop also uses TLS (`NITRO_SSL_CERT`/`NITRO_SSL_KEY`); Caddy verifies its pinned private certificate. The Node preset derives the Request URL scheme from this transport. Switching the hop to plaintext breaks the application's strict origin checks; do not disable those checks or skip certificate validation.

The scanner uses its own pinned TLS identity and HMAC secret, digest-pinned parser containers and bounded admission. Startup readiness finishes before the listener opens; the coordinator starts after a successful scanner probe. `gotchu-scanner-refresh.timer` drains scanner/coordinator and updates the offline vulnerability database daily at 07:00 UTC (03:00 Venezuela), then resumes them. This maintenance briefly delays queued work while web/database remain available.

Customer scripts/tests, the VM validator, provider-write executor, optional model investigator and gateway remain disabled. Containers parsing source are not VM-class isolation. A scanner/Docker compromise can compromise this shared host; separate users do not contain host-root compromise.

## Operator commands

Use the private deployment key retained locally under `.local/aws/lightsail.pem`; never commit it. Once connected, use systemd for the hosted runtime, rather than launching another copy with `./gotchu up`:

```sh
sudo systemctl status gotchu-data gotchu@web gotchu@coordinator gotchu@scanner
sudo journalctl -u gotchu@web -u gotchu@coordinator -u gotchu@scanner --since '10 minutes ago'
sudo systemctl list-timers 'gotchu-*'
sudo cat /var/lib/gotchu-backup/last-success
sudo systemctl start gotchu-backup.service
```

For a new release: back up, drain coordinator/scanner, prepare dependencies/builds separately, preserve the existing private state and Compose project/volumes, run required migrations as the operator, install reviewed service files and restart. Do not overwrite live state, run development registration, or run a second daemon launcher alongside systemd. There is no automatic database migration rollback.

Production delivery now uses the protected `main` → `prod` promotion workflow and an independent host installer. See [CI/CD and recovery](cicd.md) for the release decision, OIDC permissions, immutable artifacts, maintenance transaction and reconciliation procedure. The original manual initialization above remains a bootstrap procedure, not the normal update path.

The hosted web service uses `NODE_ENV=production` and explicit `GOTCHU_AUTH_MODE=public`. Anyone can choose **Crear una cuenta** at `/dashboard`, register an email/password and create their own isolated workspace without a setup token, invitation or manual approval. New accounts receive no membership in existing workspaces. `/setup` redirects to the regular dashboard and the setup API returns 404; stored bootstrap records and existing accounts are preserved. The separate `self_host` mode retains its private one-use Owner bootstrap. No external login or paid email service is configured. Local email is an unverified account identifier; do not enable automatic account linking or mailbox-based recovery on that assumption. See [signup security boundaries](../../docs/public-signup-security.md) before enabling another identity provider.

For first-time initialization, prepare the existing self-host operator state with a loopback `PUBLIC_APP_URL` and run the app's initialization/migrations privately. Stop that detached launcher, set the canonical public origin in the operator state, and install supervised services. The public proxy requires the private web certificate generated by `install-services.sh`; installing that final proxy before initial plain-HTTP bootstrap will not work.

## Backup and recovery

`gotchu-backup.timer` runs every ten minutes. [backup.sh](backup.sh) captures a consistent custom-format PostgreSQL dump, runtime configuration, scanner secrets, operator state, and the private web event-signing credential directory. It encrypts the archive with the existing AES-256-GCM/scrypt utility before upload. A backup-only IAM user has `PutObject` on this bucket's two prefixes and cannot read/delete backup history. This scoped credential requires operator rotation; developer/root AWS credentials are never installed on the host.

S3 versioning is enabled. Frequent backups expire after three days, daily copies after fourteen days, noncurrent versions and abandoned multipart uploads after one day. Daily copies are uploaded once per UTC day. The script refuses compressed plaintext archives above 256 MiB: exceeding that bound is a **failed backup requiring an operator storage review**, not successful recovery coverage. The successful-backup timestamp updates only after both required uploads finish.

The root-only encryption key is `/etc/gotchu-backup/key`; a private recovery copy is retained locally as `.local/aws/backup-key`. Move that copy to the operator's secure password/file vault outside the serving host. The host copy, S3 encryption and same-account versioning do not protect against a compromised AWS account or host-root attacker.

Restore procedure:

1. Stop workers and web on the recovery host; retain a copy of its prior state. Retrieve an exact completed S3 object using an operator identity with read permission.
2. Decrypt with `node scripts/gotchu-backup-crypto.mjs decrypt <backup> <payload.tar.gz>`, providing the recovery key on stdin. Treat all extracted content as private; inspect paths before privileged extraction. This hosted archive contains more directories than the local `./gotchu restore` format and must not be passed to that command.
3. Restore PostgreSQL into the intended stopped installation and restore the archived `/etc/gotchu`, operator and runtime state directories with their original restricted ownership. Reinstall the exact recorded release and roles. Restore a web credential directory to the web service UID, not another user.
4. In the restored database, increment `gotchu.platform_state.recovery_epoch`, set `writes_frozen=true` and clear `reconciliation_reference`. Reconcile uncertain jobs/actions before any provider writes. Redis is rebuilt from durable PostgreSQL/outbox state; do not revive old approval authority.
5. Start supervised data/scanner/coordinator/web, verify login and persisted reports/events, inspect backup age and measure actual loss/time to recovery.

Ten-minute scheduling supports the prior pilot recovery objective only while backups are completing successfully. It is not a measured fifteen-minute RPO or four-hour clean-host RTO guarantee. Full clean-host recovery, Venezuelan latency and representative capacity remain separate validation work.

## Initial deployment verification — 2026-10-24

- Local production build and workspace typecheck passed. Scanner package checks: 29 passed, one optional live smoke skipped. Customer integration: five passed, one optional scanner case skipped, using disposable real PostgreSQL/Redis; these local runs are not AWS evidence.
- Live AWS: pinned Semgrep, Gitleaks, Trivy, image database and npm advisory readiness passed. A signed TLS request with isolated synthetic scope returned both expected eval/TLS findings in 17.518 seconds. A second 3,600,485-byte synthetic snapshot returned them in 6.493 seconds with at least 2,432 MiB host memory available during sampling; `oom_kill` remained zero. These small controlled cases justify the selected pilot size, not a customer throughput/accuracy guarantee.
- Live HTTPS landing and sign-in rendered in Chromium; the dashboard displayed its logged-out form without JavaScript errors. The canonical credential-provider URL remained HTTPS with spoofed forwarding headers; a cross-origin workspace write returned 403. Private ports 3000/3003/4400/5432/55432/6379/56379 were closed/filtered from the public IP.
- Automatic startup failure retries were observed while tuning cold-start admission; final scanner/coordinator/web units were active, with no restarts after the permission fix. Cold scanner startup took about one minute. A host reboot and recovery under real customer load were not tested.
- The first 75,686-byte encrypted backup uploaded to both S3 prefixes, downloaded and authenticated/decrypted. Its PostgreSQL dump restored with original roles into a disposable database on this host; recovery epoch increment and write freeze succeeded there, then the disposable database was removed. The initial dump had no customer reports. This is not clean-host disaster recovery or proof of restoring populated customer data.
- DNS was verified directly with Cloudflare authoritative/public resolvers. The collaborative browser twice returned `ERR_NAME_NOT_RESOLVED` because of negative DNS caching; browser verification used standalone Chromium with the hostname mapped to the independently verified static IP and normal certificate validation.

The initial checks above preceded public signup. Public signup keeps the existing global registration/login admission limits and workspace quotas; these bounds are not aggregate host-capacity guarantees. Keep optional integrations and release gates described above visible rather than presenting them as deployed capabilities.

## Public signup verification — 2026-10-24

- Web runtime updated to explicit public mode, retaining the existing production secret, database and TLS configuration. No infrastructure was added. A completed encrypted backup preceded the update; the prior web output and private-mode environment were retained for rollback.
- Web typecheck/build and 54 focused runtime/auth/API tests passed. The built production-public customer suite passed five tests against disposable real PostgreSQL/Redis, with one optional scanner case skipped; it exercised account signup/login, workspace creation, tenant isolation and durable reports.
- Live collaborative Chromium completed normal-form registration, CSRF-protected sign-in, sign-out and a second sign-in. The synthetic account saw zero existing workspaces and was deleted afterward after checking it owned no data. No operator account/password was chosen.
- The old setup route redirected to `/dashboard` without retaining its test query; setup POST returned 404. The 375 px signup form had no horizontal overflow and no browser console errors. All four runtime units remained active and the web unit reported zero restarts. This does not validate sustained public capacity or clean-host recovery.
