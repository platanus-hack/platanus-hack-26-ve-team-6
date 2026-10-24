# Simple AWS hosting: research and security review

Reviewed 2026-10-24 against `ce46226306f79bca23009e7d9cd2465555e751c0`, in isolated worktree `t3/aws-hosting-research`. Latest instruction: first users are in Venezuela; prioritize one inexpensive instance, backups and systemd, with no load balancer or HA claim. The old $250/month planning ceiling is **not** the current spending target.

This is source review and public AWS pricing research, not live deployment validation. Credentials initially were reported expired; the parent now reports successful authentication and is verifying identity/account. This agent performed no AWS login, account API call or resource mutation, and ran no app/scanner/recovery tests. Only this report is changed.

## Recommendation

Start with **one Linux x86_64 Lightsail general-purpose 8 GB instance at $44/month**, in **us-east-1 as the initial candidate**, with a static IPv4, a small TLS reverse proxy, systemd-supervised web/coordinator/scanner, and local PostgreSQL/Redis containers with persistent volumes. Keep customer-code execution, validator, provider-write executor and optional model investigator/gateway disabled. No ALB, NAT gateway, managed database, Kubernetes or paid model is needed for real customer assessments.

Allow approximately **$50–55/month before tax** for this small deployment and bounded backups, subject to actual retained bytes/requests and storage encryption choice. This is an estimate, not a cap. The $24/4 GB option is a worthwhile later optimization after memory/concurrency tuning and a representative test; current source does not justify claiming it reliable. The $84/16 GB option is unnecessary without measurements showing pressure.

Venezuelan users do not imply that São Paulo has the best routing. Compare HTTPS latency from actual users' Venezuelan ISPs to the candidate region before final selection; no such measurement was made here. Keep the application and backups in the selected region initially. Do not buy geographic redundancy for this launch.

## Why 8 GB rather than 4 GB

[The parser adapter](../packages/customer-assessment/src/docker.ts) starts each tool with a 768 MiB memory/swap ceiling, one CPU, 128 PIDs, no network, read-only root, nonroot UID, dropped capabilities and bounded output/time. [Internal analysis](../packages/customer-assessment/src/internal.ts) invokes Semgrep, Gitleaks and Trivy concurrently: **2.25 GiB combined ceilings**, before scanner Node, Docker, OS or application services. Semgrep also has a 384 MB tool limit; that is not the whole pipeline's limit. Tmpfs counts against container memory.

[Compose](./compose.yaml) has limits of Postgres 1 GiB, Redis 512 MiB, web 512 MiB and coordinator 768 MiB: **2.75 GiB** before proxy/OS/backups. The installer actually runs the three app processes on the host without these Compose memory limits. Limits are not measured consumption, but a nominal 5 GiB parser-plus-control envelope makes 4 GB an unproven squeeze.

The [scanner server](../apps/scanner/src/server.ts) normally serializes scans/readiness. However, [scanner main](../apps/scanner/src/main.ts) also starts a direct readiness probe outside that admission gate after listening. Startup probes/traffic can overlap it, potentially doubling parser ceilings to 4.5 GiB. Serialize startup readiness or prevent overlapping requests before serving traffic; 8 GB alone does not fix this race. Busy readiness must not trigger restart loops during active scans.

Build elsewhere or during a maintenance window: pnpm/TypeScript/Vite builds add memory/CPU pressure. Retain Node 24, pnpm 11.21.0, frozen lockfile and pinned amd64 parser images. Measure cold readiness, maximum supported source/lockfile/image inputs, web use during a scan and backup, RSS/cgroup peaks, disk/inodes and CPU credits. The 8 GB recommendation is margin, not measured throughput. Lightsail is burstable; depleted burst capacity can extend scan times. [AWS CPU behavior](https://docs.aws.amazon.com/lightsail/latest/userguide/cpu-burst-capacity-accrual.html).

## Single-host security assessment

**Reasonable for a small, bounded observation-only pilot, with an explicit shared-host compromise risk; not equivalent to separate scanner/control-plane hosts.** Customer scripts, imports, installs, builds and tests remain disabled. The parser containers process hostile data, so disabling execution reduces risk but does not eliminate parser/kernel vulnerabilities.

The controller uses `/var/run/docker.sock`; compromising that controller or escaping to the daemon can compromise the entire host, including the database and other tenants' data. Different Unix users and containers reduce ordinary accidental access but cannot withstand host-root compromise. Do not claim the architecture's stronger compromised-worker isolation has been demonstrated. Keep the optional investigation worker absent. Revisit separate hosts before enabling customer execution, privileged investigations or provider writes, or if the threat model requires containing a fully compromised scanner.

Minimum controls for this topology:

- Separate web/coordinator/scanner service users and service-specific credentials. Only scanner orchestration gets Docker access; web/coordinator must not join the Docker group or read migration/backup secrets. Parser containers get only source/profile mounts, never database, Auth.js, AWS or repository credentials. No privileged containers or Docker socket inside parsers.
- Public ingress only 443 and 80 for redirect/ACME, plus SSH restricted to the operator's source addresses. Bind web, coordinator, scanner, Postgres and Redis to loopback; cover IPv6 too. Lightsail firewall rules protect public ingress, **not private-IP traffic or outbound traffic**; verify host/Docker firewall behavior. [AWS firewall semantics](https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-firewall-and-port-mappings-in-amazon-lightsail.html).
- Preserve scanner TLS/HMAC and coordinator-scoped CA; existing local certificates cover loopback. Parser network remains disabled. Trusted scanner orchestration separately needs public DNS/HTTPS for authorized target assessments, OSV and npm metadata/artifacts. Preserve public-address validation, DNS pinning and target consent; do not expose a generic fetch endpoint.
- Configure `PUBLIC_APP_URL=https://gotchu.kevinbravo.com`, trusted canonical Host/proto handling, secure cookies, renewable TLS and bounded request sizes/time/rates. Exclude setup tokens and credentials from logs. Proxy limits must accommodate supported uploads. Use private secret files, not source, user-data output or shell logs.
- Keep DB runtime roles distinct and unprivileged; migration/admin credentials are not runtime credentials. Limit logs, scanner scratch data and retained uploads. Preserve unknown coverage on timeout/tool failure rather than manufacturing successful reports.

## Durable operation and product readiness

[The installer](../gotchu) uses `setsid`/`nohup` for web/coordinator/scanner; it does not restart failed processes or restore them after reboot. Add **systemd units** with boot ordering, restart backoff, explicit users/environment files, graceful shutdown and bounded logs. Keep Postgres/Redis volumes and restart policies. Avoid wrapping a detached launcher in a unit and assuming systemd tracks each child correctly.

Postgres owns requests, leases, reports and transactional outbox intent; Redis/BullMQ is delivery. The **coordinator** is the durable assessment worker; `apps/worker` is the optional model investigator. Test coordinator kill/restart, host reboot, Redis loss/reconstruction and stuck scanner cleanup. Preserve quarantines for unknown outcomes instead of blindly replaying potentially still-running external scans. [Architecture](../docs/architecture.md), [coordinator](../apps/coordinator/src/main.ts), [job handling](../apps/coordinator/src/jobs.ts).

The checked-in Compose scanner/agent/gateway/executor are placeholders, and its coordinator uses development mode. Existing [Pulumi](./pulumi/src/infrastructure.ts) creates two hosts/storage, not a running customer product; its no-Internet scanner subnet conflicts with current external scans. Do not use either unchanged as deployment evidence. Some [deployment prose](./deployment.md) still describes the fictional demo; the real customer application is the authorized scope.

### Authentication and onboarding constraints

[Runtime](../apps/web/src/server/runtime.ts), [Auth.js](../apps/web/src/server/auth.ts), [customer API](../apps/web/src/server/customer-api.ts) and [setup test source](../apps/web/test/self-host-setup-postgres.test.ts):

- Production `GOTCHU_AUTH_MODE=self_host` supports local password sign-in without a paid identity vendor. Use a private `AUTH_SECRET` of at least 32 characters. A privately delivered setup token expires in one hour and creates the first local account/workspace/Owner atomically. OAuth cannot replace that first bootstrap.
- **Additional users are a real prerequisite:** production/self-host open local registration is disabled. Invitations do not create local accounts. Configure a chosen OAuth/generic OIDC provider, or implement a secure invitation/account-creation path before claiming multi-user readiness. Never expose development mode to bypass this.
- Google requires verified email; an email already belonging to a local account must use its password because explicit linking is absent. GitHub sign-in callback is `/api/auth/callback/github`; repository integration uses `/api/customer/github/callback`. Google uses `/api/auth/callback/google`; OIDC needs the exact generated provider callback. Repository access remains optional and separate from login.
- Local accounts do not verify mailbox ownership. Test invitation delivery, password/account recovery and final-domain WebAuthn where offered; do not promise unavailable recovery. Generic OIDC is replaceable, and no particular external vendor is mandatory.
- Acceptance must include a real source upload/queued report and a **source-free**, DNS-authorized HTTPS assessment, another tenant's denial case, and a usable final-domain browser login. The fictional fixture is not the product. Hosting this domain does not authorize scanning arbitrary customer domains.

## Backups and honest failure limits

Use encrypted **off-host** PostgreSQL/configuration backups, plus bounded daily host snapshots for convenient rebuilds. Existing `./gotchu backup` is an interactive consistent logical dump encrypted with AES-GCM, stored beside the state directory by default; it neither schedules nor uploads. Its archive contains `.env`, state identity, scanner TLS/HMAC and optional GitHub Reader credentials, but **omits `event-credentials/`, monitoring repository configuration and other optional secret stores**. Include every enabled integration's required secret/configuration in a reviewed recovery manifest. [Installer](../gotchu), [archive whitelist](../scripts/gotchu-backup-archive.mjs), [self-host guide](../docs/self-hosting.md).

A minimal scheduled daily off-host dump is simple but means **up to roughly a day of data loss plus backup/upload lag**, longer if backups fail. It does **not** meet the historical accepted 15-minute RPO. Before customer launch, either implement bounded continuous WAL archiving with base backups and freshness alarms, or explicitly accept a different recovery objective; the request for simplicity alone is not acceptance of lost data. The old four-hour RTO also remains unproven. AWS daily snapshots retain seven generations; they supplement, not replace, database-consistent off-host recovery. [AWS snapshots](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-snapshots.html).

Keep backup storage private/encrypted, with finite current/noncurrent version retention and multipart cleanup. Separate restore/delete authority and decryption material from the serving host; uploader should not delete backup history. Same-account versioning does not protect against account-wide compromise. Lightsail's create API has no EC2 instance-profile field: select a renewable backup-only credential mechanism or explicitly review a narrowly scoped rotated credential; never copy developer AWS access into the app. [AWS create API](https://docs.aws.amazon.com/cli/latest/reference/lightsail/create-instances.html).

Restore into a clean host; recover DB and complete secrets, freeze provider writes/increment recovery epoch, reconcile uncertain jobs and rebuild Redis delivery from durable state, then verify login/events/reports. [Recovery implementation](../packages/database/src/migrate.ts). Measure actual loss and recovery time. Host/disk/AZ failure interrupts this whole application; there is no failover or HA claim.

Verify encryption of the selected instance storage rather than assuming every root-disk setting. AWS explicitly documents encryption for **attached** disks/snapshots; a 40 GB encrypted attached data disk would add $4/month at $0.10/GB-month if needed. Include source scratch, secrets and any swap in the storage decision. [AWS block storage](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-block-storage.html), [pricing](https://aws.amazon.com/lightsail/pricing/).

## Costs and alternatives — official AWS sources only

USD, Linux on-demand, us-east-1; 730 hours/month for hourly services, published monthly bundle ceilings for Lightsail. No tax, free trial, credits, Spot or commitments assumed. Prices accessed 2026-10-24; no authenticated regional availability check.

| Option | Memory / vCPU | Disk assumption | Monthly base |
| --- | --- | --- | ---: |
| Lightsail general-purpose | 4 GB / 2 | 80 GB included | $24.00 |
| **Recommended Lightsail** | **8 GB / 2** | **160 GB included** | **$44.00** |
| Lightsail general-purpose | 16 GB / 4 | 320 GB included | $84.00 |
| Lightsail memory-optimized | 16 GB / 2 | 160 GB included | $74.00 |
| EC2 t3a.large | 8 GiB / 2 | 160 GiB gp3 + one IPv4 | $71.35 |
| EC2 t3a.xlarge | 16 GiB / 4 | 320 GiB gp3 + one IPv4 | $139.04 |
| EC2 t3.large / t3.xlarge | 8 / 16 GiB | Same respective disk/IP | $77.19 / $150.72 |

[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) includes 4/5/6 TB transfer for the 4/8/16 GB general-purpose plans. Attached static IPv4 has no extra charge. [AWS static-IP billing](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html). The memory-optimized option is confirmed by [AWS's launch notice](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-lightsail-memory-optimized-instances/).

EC2 compute: t3a.large/xlarge $0.0752/$0.1504/hour; t3.large/xlarge $0.0832/$0.1664. [AWS T3 pricing](https://aws.amazon.com/ec2/instance-types/t3/). gp3 modeled at $0.08/GiB-month and public IPv4 $0.005/hour. [AWS regional gp3 comparison](https://docs.aws.amazon.com/emr/latest/ManagementGuide/emr-plan-storage-compare-volume-types.html), [VPC pricing](https://aws.amazon.com/vpc/pricing/). Smaller EC2 disks reduce cost, but bandwidth/backups and burst surplus add charges. T3 Unlimited Linux surplus CPU is $0.05/vCPU-hour; Standard trades that exposure for throttling. [AWS on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

**Example backup-inclusive bill:** $44 host + $2.50 for 50 GB billable retained snapshot data + $1.15 for 50 GB S3 Standard backups + $0.05 for 10,000 S3 PUT/LIST requests = **$47.70/month**. An optional additional DNS zone adds $0.50; an optional 40 GB data disk adds $4: **$52.20 with both**. Existing `kevinbravo.com` DNS may avoid another zone. These retained sizes are assumptions, not measured requirements; snapshot churn/WAL can exceed them. Monitoring, additional transfer/requests, recovery drill hosts and tax are extra.

Snapshot rate is $0.05/GB-month, incremental changed/retained data. [AWS snapshot billing](https://aws.amazon.com/about-aws/whats-new/2019/10/amazon-lightsail-now-provides-automatic-snapshots/). [Official S3 us-east-1 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json), publication `2026-10-15T17:35:40Z`, gives Standard $0.023/GB-month, PUT/LIST $0.005/1,000 and GET $0.0004/1,000. [Route 53](https://aws.amazon.com/route53/pricing/) lists $0.50/zone-month plus query charges. These public `current` price-list URLs change over time; recorded dates/rates identify this review.

**Why not ECS/Fargate plus managed DB:** the scanner's Docker-socket/host-mount adapter cannot run unchanged on Fargate, which denies access to the host container runtime/privileged Docker setup. [AWS restrictions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html). A replacement task-based adapter is additional implementation, not configuration.

For comparison only, a hybrid with Fargate web/coordinator/Redis totaling 2 vCPU/4 GiB continuously ($72.08), RDS PostgreSQL db.t3.small Single-AZ plus 20 GiB gp3 ($28.58), ALB plus two IPv4 ($23.73), three task public IPv4 ($10.95), and EC2 t3a.large scanner with 80 GiB gp3/IPv4 ($64.95) totals **$200.28 before usage/backups/logs** (sum before rounding). This is still not HA and is rejected for this launch. Private tasks behind one NAT increase base to about $225.83 plus NAT processing. No such resources are proposed.

[Official ECS price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json), publication `2026-10-19T22:43:17Z`: x86 $0.04048/vCPU-hour + $0.004445/GB-hour. [Official RDS list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json), publication `2026-10-20T00:32:32Z`: PostgreSQL db.t3.small $0.036/hour, gp3 $0.115/GB-month. [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/): $0.0225/hour + $0.008/LCU-hour; [NAT/IP pricing](https://aws.amazon.com/vpc/pricing/): gateway $0.045/hour + $0.045/GB, IPv4 additional. Redis is included in the task allocation, not assumed free.

Managed DB can be reconsidered if backup operations become burdensome. Lightsail's encrypted 2 GB standard DB adds $30/month; reject its $15/1 GB tier for customer data because it advertises no data encryption. [AWS plans](https://aws.amazon.com/lightsail/pricing/). RDS/db.t4g can reduce DB compute without changing x86 app binaries, but migration/admin-role and TLS compatibility require testing: Gotchu's bootstrap assumes local Compose and role ownership/SET ROLE; RDS does not provide unrestricted PostgreSQL superuser. [Migration source](../packages/database/src/migrate.ts), [AWS administrative roles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html).

## Billing safeguards and exact remaining prerequisites

Set actual/forecast alerts around the chosen small infrastructure allocation (for example $50 and $60), with a verified recipient and daily resource/usage review. **AWS Budgets are not hard caps** and notifications lag charges. [AWS warning](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html). One fixed host, no autoscaling/provisioning rights for app services, bounded scan admission/retries, global queue limits, rate limits, finite snapshots/backups/logs and usage alarms are the practical controls. Per-tenant quotas alone do not bound unlimited tenants. Model services remain off.

Monitor disk/WAL, backup age, retained snapshot bytes, transfer and CPU credits. Lightsail inbound/outbound traffic consumes allowance; outbound excess costs extra. Stopping an instance does not stop its bundle billing, and deleting it can leave charged snapshots/disks/IPs. Do not destroy accepted customer data to satisfy an alarm. [AWS billing](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html), [deletion behavior](https://docs.aws.amazon.com/lightsail/latest/userguide/delete-an-amazon-lightsail-instance.html).

Parent must resolve before claiming readiness:

1. Verify authenticated account/role, region/bundle/x86 blueprint, existing resources and DNS ownership; establish restricted administrator access. Check latency from Venezuelan users. No child cloud mutations.
2. Implement systemd supervision, production secrets/users, ingress TLS renewal/firewalls, storage encryption, serialized startup readiness, release/rollback and image/advisory refresh. Verify with crash/reboot and measured 8 GB resource tests.
3. Complete private first-Owner bootstrap and select/test the additional-user login path. Set final-domain callbacks; no production local-registration bypass.
4. Automate complete encrypted off-host backups including event-signing keys; choose recovery objective explicitly, measure clean-host restore, freeze/reconcile restored jobs/authorization, and document downtime/data-loss limits.
5. Validate real authenticated tenant flows, source scan/report and source-free authorized HTTPS assessment in the hosted browser; verify private ports and tenant denial. Keep customer execution/provider writes off and record the single-host compromise limitation.

Reviewed AGENTS.md, definition-interview.md, architecture.md, implementation-plan.md, self-host/runtime/scanner/backup code, package/lock/TypeScript configuration and nearby tests. Report-only checks: official public price retrieval, arithmetic, local-link existence and diff review. No new live infrastructure, scanner, browser or recovery evidence is claimed.
